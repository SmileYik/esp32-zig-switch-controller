const std = @import("std");
const mod = @import("root.zig");
const sys = mod.sys;
const Allocator = std.mem.Allocator;
const Protocol = mod.protocol.Protocol;

const ReportTag = mod.report.ReportTag;
const ReportType = mod.report.ReportType;

const testing = std.testing;
const ExpectEqual = testing.expectEqual;
const log = std.log.scoped(.report_queue);

const SEND_REPORT_BIT = @as(c_int, 0x1);

pub fn ReportQueue(comptime size: usize) type {
    return struct {
        pub const Queue = mod.Queue(ReportType, size);
        const Self = @This();

        const Options = struct {
            queue: ?Queue = null,
            protocol: Protocol,
        };

        running: std.atomic.Value(bool) = .init(false),
        task_mutex: mod.Mutex,

        allocator: Allocator,
        queue: Queue,
        protocol: Protocol,
        bt: *mod.bt,
        is_connected: std.atomic.Value(bool) = .init(false),
        snapshot_input: ReportType = .{ .input = .{} },

        send_mutex: mod.Mutex,
        send_event_group: sys.EventGroupHandle_t = null,
        send_event_status: c_uint = 0,

        pub fn init(allocator: Allocator, opt: Options, bt_opt: mod.bt.Options) !*Self {
            const p: *Self = try allocator.create(Self);
            errdefer allocator.destroy(p);

            var mutex: mod.Mutex = try .init();
            errdefer mutex.deinit();

            var send_mutex: mod.Mutex = try .init();
            errdefer send_mutex.deinit();

            var queue = opt.queue orelse try Queue.init(.{
                .allocator = allocator,
                .deinitValueFn = &deinitReportTag,
                .initValueFn = &dupeReportTag,
            });
            errdefer if (opt.queue == null) queue.deinit();

            const send_event_group = sys.xEventGroupCreate() orelse return error.EventGroupCreateFailed;
            errdefer send_event_group.vEventGroupDelete();

            p.* = .{
                .allocator = allocator,
                .bt = undefined,
                .protocol = opt.protocol,
                .queue = queue,
                .task_mutex = mutex,
                .send_mutex = send_mutex,
                .send_event_group = send_event_group,
            };

            var bt = try mod.bt.init(allocator, p, bt_opt);
            errdefer bt.deinit();

            p.bt = bt;
            return p;
        }

        pub fn deinit(self: *Self) void {
            self.running.store(false, .release);
            while (true) {
                self.queue.enqueueWait(.stop, mod.sys.pdMS_TO_TICKS(60000)) catch continue;
                break;
            }

            self.task_mutex.lockUncancelable();
            self.task_mutex.unlock();
            self.task_mutex.deinit();
            self.send_mutex.deinit();
            self.bt.deinit();

            self.queue.deinit();
            self.allocator.destroy(self);
        }

        pub fn start(self: *Self) !void {
            self.running.store(true, .release);
            _ = try mod.idf.rtos.Task.create(
                reportTask,
                "report_task",
                1024 * 8,
                self,
                10,
            );
        }

        pub inline fn enqueue(self: *Self, item: ReportType) !void {
            try self.queue.enqueue(item);
        }

        pub inline fn enqueueWait(self: *Self, item: ReportType, ticks: u32) !void {
            try self.queue.enqueueWait(item, ticks);
        }

        pub inline fn spacesAvailable(self: *Self) usize {
            return self.queue.spacesAvailable();
        }

        fn dupeReportTag(allocator: Allocator, old: ReportType) !ReportType {
            return switch (old) {
                .incoming => |s| .{ .incoming = if (s == null) null else try allocator.dupe(u8, s.?) },
                .sending => |s| .{ .sending = try allocator.dupe(u8, s) },
                else => old,
            };
        }

        fn deinitReportTag(allocator: Allocator, item: ReportType) void {
            switch (item) {
                .incoming => |s| if (s) |*ss| allocator.free(ss.*),
                .sending => |s| allocator.free(s),
                else => {},
            }
        }

        inline fn handleInputSnapshot(self: *Self, report: ?ReportType) void {
            if (self.snapshot_input == .input) {
                const s = self.snapshot_input.input;
                self.protocol.setButtonInputs(s.upper, s.shared, s.lower);
                self.protocol.setLeftStickInputs(s.left_stick_centre);
                self.protocol.setRightStickInputs(s.right_stick_centre);
            }
            if (report) |r| switch (r) {
                .input => |s| {
                    self.snapshot_input = .{ .input = s };
                },
            };
        }

        fn sendReportInner(self: *Self, data: []u8) !void {
            self.send_mutex.lockUncancelable();
            defer self.send_mutex.unlock();

            while (true) {
                _ = sys.xEventGroupClearBits(
                    self.send_event_group,
                    SEND_REPORT_BIT,
                );
                self.bt.sendReport(data) catch |err| {
                    log.err(
                        "[SEND_REPORT] API send failed: {s}",
                        .{@errorName(err)},
                    );
                    return err;
                };

                _ = sys.xEventGroupWaitBits(
                    self.send_event_group,
                    SEND_REPORT_BIT,
                    1,
                    0,
                    sys.portMAX_DELAY,
                );

                const status = self.send_event_status;
                switch (status) {
                    sys.ESP_HIDD_SUCCESS => {
                        self.protocol.nextTimer();
                        return;
                    },

                    sys.ESP_HIDD_BUSY, sys.ESP_HIDD_NO_RES => {
                        mod.idf.rtos.Task.delayMs(2);
                        log.warn(
                            "[SEND_REPORT] recoverable status={d}, retrying",
                            .{status},
                        );
                        continue;
                    },

                    else => {
                        log.err(
                            "[SEND_REPORT] unrecoverable status={d}",
                            .{status},
                        );

                        return error.SendReportFailed;
                    },
                }
            }
        }

        export fn reportTask(ctx: ?*anyopaque) callconv(.c) void {
            var self: *Self = @ptrCast(@alignCast(ctx.?));
            self.task_mutex.lockUncancelable();
            defer mod.idf.rtos.Task.delete(null);
            defer self.task_mutex.unlock();

            while (true) {
                while (self.queue.pollWait(std.math.maxInt(u32))) |*item| {
                    defer item.deinit();

                    // drop report if not connected.
                    if (!self.is_connected.load(.acquire) and item.value != .stop) {
                        continue;
                    }

                    switch (item.value) {
                        .incoming => |s| {
                            self.protocol.processCommands(s orelse &[_]u8{});
                            self.handleInputSnapshot(null);
                            defer self.protocol.clearReport();
                            switch (self.protocol.response) {
                                .no_data, .malformed, .too_short => {
                                    if (s == null) {
                                        self.sendReportInner(self.protocol.report[0..]) catch {};
                                    }
                                },
                                else => {
                                    self.sendReportInner(self.protocol.report[0..]) catch {};
                                },
                            }
                        },

                        .sending => |s| {
                            self.sendReportInner(s) catch {};
                        },

                        .input => |s| {
                            self.protocol.setFullInputReport();
                            self.protocol.setButtonInputs(s.upper, s.shared, s.lower);
                            self.protocol.setLeftStickInputs(s.left_stick_centre);
                            self.protocol.setRightStickInputs(s.right_stick_centre);
                            self.snapshot_input = .{ .input = s };
                            defer self.protocol.clearReport();
                            self.sendReportInner(self.protocol.report[0..]) catch {};
                        },

                        .sleep => |ms| {
                            mod.idf.rtos.Task.delayMs(ms);
                        },

                        .stop => return,
                    }
                }
            }
        }

        pub fn handleHIDD(self: *Self, event: mod.bt.HIDDEvent) void {
            if (!self.running.load(.acquire)) return;
            switch (event) {
                .open => {
                    self.is_connected.store(true, .release);
                    self.enqueue(.{ .incoming = null }) catch |e| {
                        log.err("[HIDD] [open] error when enqueue: {}", .{e});
                    };
                },
                .close => {
                    self.is_connected.store(false, .release);
                },
                .intr => |intr_opt| {
                    if (intr_opt) |intr| {
                        if (intr.data != null and intr.len > 0) {
                            const rx_slice = intr.data[0..intr.len];

                            self.enqueue(.{ .incoming = rx_slice }) catch |e| {
                                log.err("[HIDD] [intr] error when enqueue: {}", .{e});
                            };
                        }
                    }
                },
                .send_report => |send_report_opt| {
                    if (send_report_opt) |s| {
                        self.send_event_status = s.status;
                        _ = sys.xEventGroupSetBits(self.send_event_group, SEND_REPORT_BIT);
                    }
                },
                else => {},
            }
        }
    };
}
