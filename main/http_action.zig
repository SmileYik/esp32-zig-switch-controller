const std = @import("std");
const mod = @import("root.zig");
const web = @import("web");
const sys = mod.sys;
const idf = mod.idf;

const runner = mod.controller.command.runner;
const CommandRunner = runner.CommandRunner(runner.CallStackStatic(8));

const MAX_BODY_SIZE = 4096;
pub const QUEUE_CAPACITY = 255;
pub const QUEUE_CAPACITY_INIT = 16;
const Queue = mod.Queue(ByteCode, QUEUE_CAPACITY);

const log = std.log.scoped(.http_action);

const ByteCode = struct {
    bytes: []const u8,
    allocator: std.mem.Allocator,

    pub fn deinit(self: *ByteCode) void {
        self.allocator.free(self.bytes);
    }
};

const Self = @This();

allocator: std.mem.Allocator,
heap: *idf.heap.HeapCapsAllocator,
controller: *mod.controller.Controller,
wifi: *mod.wifi.WifiManager,

queue: Queue,
queue_capacity: u8 = QUEUE_CAPACITY_INIT,
// expect
queue_init: std.atomic.Value(bool) = .init(false),
queue_expect_idx: std.atomic.Value(u32) = .init(0),
queue_total: u32 = 0,

uris: [4]mod.http.Uri = [_]mod.http.Uri{
    .{
        .uri = "/",
        .method = sys.HTTP_GET,
        .handler = &handleRoot,
        .user_ctx = null,
    },
    .{
        .uri = "/api",
        .method = sys.HTTP_OPTIONS,
        .handler = &handleApiOptions,
        .user_ctx = null,
    },
    .{
        .uri = "/api",
        .method = sys.HTTP_POST,
        .handler = &handleApiPost,
        .user_ctx = null,
    },
    .{
        .uri = "/api",
        .method = sys.HTTP_GET,
        .handler = &handleApiGet,
        .user_ctx = null,
    },
},

pub fn init(
    allocator: std.mem.Allocator,
    controller: *mod.controller.Controller,
    heap: *idf.heap.HeapCapsAllocator,
    wifi: *mod.wifi.WifiManager,
) !Self {
    return .{
        .allocator = allocator,
        .controller = controller,
        .queue = try .init(.{ .allocator = allocator }),
        .heap = heap,
        .wifi = wifi,
    };
}

pub fn getUris(self: *Self) []const mod.http.Uri {
    for (&self.uris) |*uri| {
        uri.user_ctx = self;
    }
    return self.uris[0..];
}

pub fn logMemory(self: *Self) void {
    log.debug("--- memory: {d}/{d}", .{ self.heap.freeSize(), self.heap.totalSize() });
}

/// GET / — serve the index page.
export fn handleRoot(req: [*c]mod.http.Req) callconv(.c) sys.esp_err_t {
    idf.http.Server.Response.setHDR(req, "Content-Encoding", "gzip") catch {};
    idf.http.Server.Response.sendChunk(req, web.index_html_gz) catch |err| {
        log.err("sendStr: {s}", .{@errorName(err)});
        return sys.ESP_FAIL;
    };
    idf.http.Server.Response.sendChunk(req, &[_:0]u8{}) catch |err| {
        log.err("sendStr: {s}", .{@errorName(err)});
        return sys.ESP_FAIL;
    };
    return sys.ESP_OK;
}

export fn handleApiOptions(req: [*c]mod.http.Req) callconv(.c) sys.esp_err_t {
    idf.http.Server.Response.setHDR(req, "Access-Control-Allow-Headers", "*") catch {};
    idf.http.Server.Response.setHDR(req, "Access-Control-Allow-Origin", "*") catch {};
    idf.http.Server.Response.sendStr(req, "") catch {};
    return sys.ESP_OK;
}

fn dispatchAction(
    self: *Self,
    req: [*c]mod.http.Req,
    comptime actions: anytype,
) !void {
    idf.http.Server.Response.setHDR(req, "Access-Control-Allow-Headers", "*") catch {};
    idf.http.Server.Response.setHDR(req, "Access-Control-Allow-Origin", "*") catch {};

    var query: [64:0]u8 = undefined;
    var action_buf: [16:0]u8 = undefined;
    @memset(&query, 0);
    @memset(&action_buf, 0);

    try idf.http.Server.Request.getUrlQueryStr(req, &query, query.len);
    try idf.http.Server.queryKeyValue(&query, "mode", &action_buf, action_buf.len);
    const action = std.mem.sliceTo(&action_buf, 0);

    inline for (actions) |entry| {
        if (std.mem.eql(u8, action, entry[0])) {
            try entry[1](self, req);
            return;
        }
    }

    idf.http.Server.Response.sendError(req, 6, "") catch {};
}

export fn handleApiPost(req: [*c]mod.http.Req) callconv(.c) sys.esp_err_t {
    var self: *Self = @ptrCast(@alignCast(req.?.*.user_ctx.?));
    self.logMemory();
    defer self.logMemory();

    self.dispatchAction(req, POSTS) catch |err| {
        self.sendJsonError(req, 500, @errorName(err));
    };

    return sys.ESP_OK;
}

export fn handleApiGet(req: [*c]mod.http.Req) callconv(.c) sys.esp_err_t {
    var self: *Self = @ptrCast(@alignCast(req.?.*.user_ctx.?));
    self.logMemory();
    defer self.logMemory();

    self.dispatchAction(req, GETS) catch |err| {
        self.sendJsonError(req, 500, @errorName(err));
    };

    return sys.ESP_OK;
}

fn logError(
    _: *Self,
    comptime prefix: []const u8,
    err: anyerror,
) void {
    var buf: [128:0]u8 = undefined;
    const msg = std.fmt.bufPrintSentinel(
        &buf,
        prefix ++ ": {s}",
        .{@errorName(err)},
        0,
    ) catch prefix ++ ": error";

    log.err("error message: {s}, error: {s}", .{ msg, @errorName(err) });
}

fn sendError(
    _: *Self,
    req: [*c]mod.http.Req,
    comptime prefix: []const u8,
    err: anyerror,
) void {
    var buf: [256:0]u8 = undefined;
    const msg = std.fmt.bufPrintSentinel(
        &buf,
        prefix ++ ": {s}",
        .{@errorName(err)},
        0,
    ) catch prefix ++ ": error";

    idf.http.Server.Response.sendStr(req, msg) catch |e| {
        log.err("error message: {s}, sendStr: {s}", .{ msg, @errorName(e) });
        idf.http.Server.Response.sendError(req, 0, "") catch {};
    };
}

fn sendJsonError(
    self: *Self,
    req: [*c]mod.http.Req,
    comptime code: u16,
    msg: ?[]const u8,
) void {
    self.sendStructAsJsonInner(req, code, null, false, msg) catch |e| {
        self.sendError(req, "send-json-error-failed", e);
    };
}

fn sendStringAsJson(
    self: *Self,
    req: [*c]mod.http.Req,
    value: ?[]const u8,
    message: ?[]const u8,
) void {
    self.sendStructAsJsonInner(req, 200, value, true, message) catch |e| {
        self.sendError(req, "send-json-error-failed", e);
    };
}

fn sendStructAsJson(
    self: *Self,
    req: [*c]mod.http.Req,
    value: ?[]const u8,
    message: ?[]const u8,
) void {
    self.sendStructAsJsonInner(req, 200, value, false, message) catch |e| {
        self.sendError(req, "send-json-error-failed", e);
    };
}

fn sendStructAsJsonInner(
    _: *Self,
    req: [*c]mod.http.Req,
    comptime code: u16,
    value: ?[]const u8,
    has_quote: bool,
    message: ?[]const u8,
) !void {
    var buf: [512:0]u8 = undefined;
    const json = try std.fmt.bufPrintSentinel(
        &buf,
        "{{\"code\":{d},\"msg\":\"{s}\",\"data\":{s}{s}{s}}}",
        .{
            code,
            message orelse "",
            if (has_quote) "\"" else "",
            value orelse "null",
            if (has_quote) "\"" else "",
        },
        0,
    );

    try idf.http.Server.Response.setHDR(req, "content-type", "application/json");
    try idf.http.Server.Response.sendStr(req, json);
}

fn readBody(
    _: *Self,
    buffer: anytype,
    req: [*c]mod.http.Req,
) !?[]const u8 {
    var i: usize = 0;
    while (true) {
        const len = idf.http.Server.Request.receiver(req, (buffer[i..]).ptr, buffer.len - i);
        if (len > 0) {
            i += @as(usize, @intCast(len));
            if (i > buffer.len) {
                log.err("0. body too long, max body size is {d} bytes", .{MAX_BODY_SIZE});
                return error.RequestBodyTooLarge;
            } else if (i == buffer.len) {
                var test_buf: [1]u8 = undefined;
                while (true) {
                    const check_len = idf.http.Server.Request.receiver(req, &test_buf, test_buf.len);
                    if (check_len > 0) {
                        log.err("1. body too long, max body size is {d} bytes", .{MAX_BODY_SIZE});
                        return error.RequestBodyTooLarge;
                    } else if (check_len == sys.HTTPD_SOCK_ERR_TIMEOUT) {
                        continue;
                    } else break;
                }
            }
        } else if (len == sys.HTTPD_SOCK_ERR_TIMEOUT)
            continue
        else
            break;
    }
    return if (i > 0) buffer[0..i] else null;
}

// fn readBodyAlloc(
//     self: *Self,
//     allocator: std.mem.Allocator,
//     req: [*c]mod.http.Req,
// ) ?std.ArrayList(u8) {
//     var buf: [1024]u8 = undefined;
//     var array: std.ArrayList(u8) = .empty;
//     errdefer array.deinit(allocator);

//     while (true) {
//         const len = idf.http.Server.Request.receiver(req, &buf, buf.len);
//         if (len > 0) {
//             array.appendSlice(allocator, buf[0..@as(usize, @intCast(len))]) catch |e| {
//                 self.sendError(req, "Read-body-failed", e);
//                 defer array.deinit(allocator);
//                 return null;
//             };
//         } else break;
//     }
//     return array;
// }

pub fn startConsume(self: *Self) !void {
    _ = try mod.idf.rtos.Task.create(
        consumeByteCode,
        "ConsumeBytecode",
        1024 * 8,
        self,
        5,
    );
}

export fn consumeByteCode(ctx: ?*anyopaque) callconv(.c) void {
    var self: *Self = @ptrCast(@alignCast(ctx.?));

    var r = CommandRunner{
        .controller = self.controller,
        .stack = .{},
    };
    defer r.deinit();

    while (true) {
        while (self.queue.pollWait(std.math.maxInt(u32))) |*item| {
            log.info("start consuming bytecode!", .{});
            self.logMemory();
            defer self.logMemory();

            defer item.deinit();

            var bytecode = item.value;
            defer bytecode.deinit();

            if (self.queue_init.load(.acquire)) {
                if (self.queue.spacesAvailable() == QUEUE_CAPACITY) {
                    self.queue_init.store(false, .release);
                }
                continue;
            }

            if (self.controller.heartbeat) {
                self.controller.setHeartbeat(false);
                defer self.controller.setHeartbeat(true);

                r.runByteCodeUnsafe(bytecode.bytes) catch |e| {
                    log.err("exception when consuming bytecode: {s}", .{@errorName(e)});
                };
            } else {
                r.runByteCodeUnsafe(bytecode.bytes) catch |e| {
                    log.err("exception when consuming bytecode: {s}", .{@errorName(e)});
                };
            }
        }
    }
}

pub fn crc16Modbus(data: []const u8) u16 {
    var crc: u16 = 0xFFFF;
    for (data) |b| {
        crc ^= @as(u16, b);
        for (0..8) |_| {
            if ((crc & 0x1) != 0) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc;
}

// =======================================
//             API ACTIONS
// =======================================

// ---------------------------------------
//                POST
// ---------------------------------------

const POSTS = .{
    .{ "/cmd/queue", &postCommandEnqueue },
    .{ "/cmd/queue/init", &postCommandQueueInit },
    .{ "/cmd/run", &postCommandRunSync },
    .{ "/cmd/run/raw", &postCommandRunSyncRaw },
    .{ "/cmd/test", &postCommandTest },
    .{ "/cfg/wifi", &postWifiConfig },
    .{ "/cfg/queue/cmd", &postCmdQueueConfig },
    .{ "/cmd/hb/on", &postControllerHeartbeatOn },
    .{ "/cmd/hb/off", &postControllerHeartbeatOff },
};

/// POST /cfg/wifi
fn postWifiConfig(self: *Self, req: [*c]mod.http.Req) !void {
    var body_buffer: [256]u8 = undefined;
    if (try self.readBody(&body_buffer, req)) |body| {
        var parsed = std.json.parseFromSlice(
            mod.Configuration.WifiConfig,
            self.allocator,
            body,
            .{ .ignore_unknown_fields = true },
        ) catch |e| {
            self.logError("parsed-body-failed", e);
            return error.ParseWifiConfigFailed;
        };
        defer parsed.deinit();

        mod.config.storeStruct(@tagName(mod.Configuration.Keys.wf), parsed.value) catch |e| {
            self.logError("store-wifi-config-failed", e);
            return error.StoreWifiConfigFailed;
        };
        self.sendStructAsJson(req, null, "configurate wifi success");
    }
    return error.RequestBodyIsNotValid;
}

/// POST /cfg/queue/cmd
fn postCmdQueueConfig(self: *Self, req: [*c]mod.http.Req) !void {
    var body_buffer: [64]u8 = undefined;
    if (try self.readBody(&body_buffer, req)) |body| {
        const CmdQueueConfig = struct {
            cap: u8 = QUEUE_CAPACITY_INIT,
        };
        var parsed = std.json.parseFromSlice(
            CmdQueueConfig,
            self.allocator,
            body,
            .{ .ignore_unknown_fields = true },
        ) catch |e| {
            self.logError("parsed-body-failed", e);
            return error.ParseCmdQueueConfigFailed;
        };
        defer parsed.deinit();

        self.queue_capacity = parsed.value.cap;
        self.sendStructAsJson(req, null, "success");
    }
    return error.RequestBodyIsNotValid;
}

/// POST /cmd/test
fn postCommandTest(self: *Self, req: [*c]mod.http.Req) !void {
    var body_buffer: [MAX_BODY_SIZE]u8 = undefined;
    if (try self.readBody(&body_buffer, req)) |body| {
        mod.controller.command.runner.byteCodeTest(self.allocator, body) catch |e| {
            self.logError("test-failed", e);
            return error.TestFailed;
        };
        self.sendStructAsJson(req, null, "complete test!");
    }
    return error.RequestBodyIsNotValid;
}

/// POST /cmd/run/raw
fn postCommandRunSyncRaw(self: *Self, req: [*c]mod.http.Req) !void {
    var body_buffer: [MAX_BODY_SIZE]u8 = undefined;
    if (try self.readBody(&body_buffer, req)) |body| {
        var opt = mod.controller.command.parser.parseCommand(self.allocator, body) catch |e| {
            self.logError("parse-script-failed", e);
            return error.ParseMacroFailed;
        };

        if (opt) |*pack| {
            defer pack.deinit();

            var r = CommandRunner{
                .controller = self.controller,
                .stack = .{},
            };
            defer r.deinit();

            self.controller.setHeartbeat(false);
            defer self.controller.setHeartbeat(true);
            r.runCommandPack(pack);
        }
        self.sendStructAsJson(req, null, "complete!");
    }
    return error.RequestBodyIsNotValid;
}

/// POST /cmd/run
fn postCommandRunSync(self: *Self, req: [*c]mod.http.Req) !void {
    var body_buffer: [MAX_BODY_SIZE]u8 = undefined;
    if (try self.readBody(&body_buffer, req)) |body| {
        var r = CommandRunner{
            .controller = self.controller,
            .stack = .{},
        };
        defer r.deinit();

        self.controller.setHeartbeat(false);
        defer self.controller.setHeartbeat(true);
        r.runByteCode(body) catch |e| {
            self.logError("run-bytecode-failed", e);
            return error.RunBytecodeFailed;
        };

        self.sendStructAsJson(req, null, "complete test!");
    }
    return error.RequestBodyIsNotValid;
}

/// POST /cmd/queue/init
fn postCommandQueueInit(self: *Self, req: [*c]mod.http.Req) !void {
    const QueueInit = struct {
        idx: u32,
        total: u32,
    };

    var body_buffer: [64]u8 = undefined;
    if (try self.readBody(&body_buffer, req)) |body| {
        var parsed = std.json.parseFromSlice(
            QueueInit,
            self.allocator,
            body,
            .{ .ignore_unknown_fields = true },
        ) catch |e| {
            self.logError("parsed-body-failed", e);
            return error.ParseCommandQueueInitFailed;
        };
        defer parsed.deinit();

        self.queue_expect_idx.store(parsed.value.idx, .release);
        self.queue_total = parsed.value.total;
        if (self.queue.spacesAvailable() != QUEUE_CAPACITY)
            self.queue_init.store(true, .release);
        self.sendStructAsJson(req, null, "success");
    }
    return error.RequestBodyIsNotValid;
}

/// POST /cmd/queue?idx={idx}
fn postCommandEnqueue(self: *Self, req: [*c]mod.http.Req) !void {
    if (self.queue_init.load(.acquire)) {
        return error.QueueIniting;
    }

    var query: [64:0]u8 = undefined;
    var idx_c: [16:0]u8 = undefined;
    @memset(&query, 0);
    @memset(&idx_c, 0);

    try idf.http.Server.Request.getUrlQueryStr(req, &query, query.len);
    try idf.http.Server.queryKeyValue(&query, "idx", &idx_c, idx_c.len);
    const idx = try std.fmt.parseInt(u32, std.mem.sliceTo(&idx_c, 0), 10);
    if (self.queue_expect_idx.load(.acquire) != idx) {
        @memset(&idx_c, 0);
        const expect = try std.fmt.bufPrint(&idx_c, "{d}", .{self.queue_expect_idx.load(.acquire)});
        self.sendStructAsJson(req, expect, "resync");
        return;
    }

    var body_buffer: [MAX_BODY_SIZE]u8 = undefined;
    if (try self.readBody(&body_buffer, req)) |body_raw| {
        if (body_raw.len < 2) {
            return error.PayloadTooShort;
        } else if (QUEUE_CAPACITY - self.queue.spacesAvailable() >= self.queue_capacity) {
            return error.QueueFull;
        }

        // crc
        const body = body_raw[0 .. body_raw.len - 2];
        const expected_crc = std.mem.readInt(u16, body_raw[body_raw.len - 2 ..][0..2], .little);
        const real_crc = crc16Modbus(body);
        if (expected_crc != real_crc) {
            return error.CrcMismatch;
        }

        var buf = self.allocator.alloc(u8, body.len) catch |e| {
            self.logError("command-enqueue-oom", e);
            return error.AllocFail;
        };
        errdefer self.allocator.free(buf);
        @memcpy(buf[0..], body);

        self.queue.enqueue(.{ .allocator = self.allocator, .bytes = buf }) catch |err|
            switch (err) {
                Queue.QueueError.Full => {
                    self.logError("command-enqueue-full", err);
                    return error.QueueFull;
                },
                else => {
                    self.logError("command-enqueue-enqueue-error", err);
                    return error.EnqueueError;
                },
            };
        _ = self.queue_expect_idx.fetchAdd(1, .release);
        @memset(&idx_c, 0);
        const expect = try std.fmt.bufPrint(&idx_c, "{d}", .{self.queue_expect_idx.load(.acquire)});
        self.sendStructAsJson(req, expect, "enqueued!");
    }
    return error.RequestBodyIsNotValid;
}

/// POST /cmd/hb/on
fn postControllerHeartbeatOn(self: *Self, req: [*c]mod.http.Req) !void {
    self.controller.setHeartbeat(true);
    self.sendStructAsJson(req, null, "heartbeat on");
}

/// POST /cmd/hb/off
fn postControllerHeartbeatOff(self: *Self, req: [*c]mod.http.Req) !void {
    self.controller.setHeartbeat(false);
    self.sendStructAsJson(req, null, "heartbeat off");
}

// ---------------------------------------
//                GET
// ---------------------------------------

const GETS = .{
    .{ "/cfg/wifi", &getWifiConfig },
    .{ "/ip", &getIp },
    .{ "/cmd/queue", &getCommandQueueStatus },
    .{ "/cmd/hb", &getControllerHeartbeat },
    .{ "/memory", &getMemoryStatus },
};

/// GET /cfg/wifi
fn getWifiConfig(self: *Self, req: [*c]mod.http.Req) !void {
    var loaded = mod.config.loadStruct(
        self.allocator,
        @tagName(mod.Configuration.Keys.wf),
        mod.Configuration.WifiConfig,
    ) catch
        mod.config.DefaultConfig(mod.Configuration.WifiConfig{});
    defer loaded.deinit();

    const template =
        \\{{"ap":{{"ssid": "{s}", "pwd":"{s}"}},"sta":{{"ssid": "{s}", "pwd":"{s}"}}}}
    ;

    var buf: [256]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, template, .{
        loaded.config.ap.ssid,
        loaded.config.ap.pwd,
        loaded.config.sta.ssid,
        loaded.config.sta.pwd,
    }) catch {
        return error.MsgBufTooSmall;
    };
    self.sendStructAsJson(req, msg, null);
}

/// GET /ip
fn getIp(self: *Self, req: [*c]mod.http.Req) !void {
    if (self.wifi.ip) |ip| {
        var buf: [16]u8 = undefined;
        const msg = std.fmt.bufPrint(
            &buf,
            "{}.{}.{}.{}",
            .{
                @as(u8, @truncate(ip)),
                @as(u8, @truncate(ip >> 8)),
                @as(u8, @truncate(ip >> 16)),
                @as(u8, @truncate(ip >> 24)),
            },
        ) catch {
            return error.MsgBufTooSmall;
        };
        self.sendStringAsJson(req, msg, null);
    } else {
        self.sendStructAsJson(req, null, "No IP.");
    }
}

/// get /cmd/queue
fn getCommandQueueStatus(self: *Self, req: [*c]mod.http.Req) !void {
    const total = self.queue_capacity;
    const space = total - (QUEUE_CAPACITY - self.queue.spacesAvailable());

    var buf: [48]u8 = undefined;
    const template =
        \\{{"total":{d},"available":{d}}}
    ;
    const msg = std.fmt.bufPrint(&buf, template, .{ total, space }) catch {
        return error.MsgBufTooSmall;
    };
    self.sendStructAsJson(req, msg, null);
}

/// get /cmd/hb
fn getControllerHeartbeat(self: *Self, req: [*c]mod.http.Req) !void {
    self.sendStructAsJson(
        req,
        if (self.controller.heartbeat) "true" else "false",
        null,
    );
}

/// get /memory
fn getMemoryStatus(self: *Self, req: [*c]mod.http.Req) !void {
    var buf: [128]u8 = undefined;
    const template =
        \\{{"total":{d},"free":{d},"internalFree":{d},"largestFree":{d},"mininumFree":{d}}}
    ;
    const msg = std.fmt.bufPrint(
        &buf,
        template,
        .{
            self.heap.totalSize(),
            self.heap.freeSize(),
            self.heap.internalFreeSize(),
            self.heap.largestFreeBlock(),
            self.heap.minimumFreeSize(),
        },
    ) catch return error.MsgBufTooSmall;
    self.sendStructAsJson(req, msg, null);
}
