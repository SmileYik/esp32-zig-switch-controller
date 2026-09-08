const std = @import("std");
const mod = @import("root.zig");
const Mutex = @import("mutex");

const ButtonLower = mod.Constants.ButtonLower;
const ButtonShared = mod.Constants.ButtonShared;
const ButtonUpper = mod.Constants.ButtonUpper;

const ReportType = @import("report").ReportType;

const testing = std.testing;
const ExpectEqual = testing.expectEqual;

const log = std.log.scoped(.controller);

const Controller = @This();

/// NS Switch Controller Pro x/y value in [0, 4095], u12
pub const StickCalibration = struct {
    center_x: i16 = 2070,
    center_y: i16 = 2013,
    min_x: i16 = -1522,
    max_x: i16 = 1414,
    min_y: i16 = -1531,
    max_y: i16 = 1510,
};

pub const Options = struct {
    left_stick_calibration: StickCalibration = .{},
    right_stick_calibration: StickCalibration = .{},

    /// unit is HZ
    heartbeat_rate_hz: u32 = 50,
};

button_upper: u8 = 0,
button_shared: u8 = 0,
button_lower: u8 = 0,
left_stick_centre: [3]u8 = [_]u8{ 0, 0, 0 },
right_stick_centre: [3]u8 = [_]u8{ 0, 0, 0 },

left_stick_calibration: StickCalibration,
right_stick_calibration: StickCalibration,

mutex: Mutex,
allocator: std.mem.Allocator,
_handler: mod.ControllerHandler,
running: std.atomic.Value(bool) = .init(false),
heartbeat: bool = true,

pub fn init(allocator: std.mem.Allocator, handler: anytype, opt: Options) !*Controller {
    const ptr: *Controller = try allocator.create(Controller);
    errdefer allocator.destroy(ptr);

    var mutex = try Mutex.init();
    errdefer mutex.deinit();

    ptr.* = .{
        .mutex = mutex,
        .allocator = allocator,
        ._handler = mod.ControllerHandler.init(handler),
        .left_stick_calibration = opt.left_stick_calibration,
        .right_stick_calibration = opt.right_stick_calibration,
    };

    ptr.resetStick(.left_stick);
    ptr.resetStick(.right_stick);

    return ptr;
}

pub fn deinit(self: *Controller) void {
    self.running.store(false, .release);
    self.mutex.deinit();
    self.allocator.destroy(self);
}

fn packetUnlocked(self: *Controller) ReportType {
    return .{
        .input = .{
            .lower = self.button_lower,
            .shared = self.button_shared,
            .upper = self.button_upper,
            .left_stick_centre = self.left_stick_centre,
            .right_stick_centre = self.right_stick_centre,
        },
    };
}

pub fn packet(self: *Controller) ReportType {
    self.mutex.lockUncancelable();
    defer self.mutex.unlock();

    return self.packetUnlocked();
}

pub fn setStickCalibration(self: *Controller, stick: mod.StickType, calibration: StickCalibration) void {
    self.mutex.lockUncancelable();
    defer self.mutex.unlock();

    switch (stick) {
        .left_stick => {
            self.left_stick_calibration = calibration;
        },
        .right_stick => {
            self.right_stick_calibration = calibration;
        },
    }
}

pub fn pressButton(self: *Controller, button: mod.Button, state: mod.ButtonState, combine: bool) void {
    self.mutex.lockUncancelable();
    defer self.mutex.unlock();

    switch (button) {
        .lower => |mask| self.button_lower = setButtonBit(self.button_lower, @intFromEnum(mask), state),
        .shared => |mask| self.button_shared = setButtonBit(self.button_shared, @intFromEnum(mask), state),
        .upper => |mask| self.button_upper = setButtonBit(self.button_upper, @intFromEnum(mask), state),
    }

    log.debug(
        "set button [{}] to [{}]. combine = [{}], [lower, shared, upper] = [{x}, {x}, {x}]",
        .{
            button,
            state,
            combine,
            self.button_lower,
            self.button_shared,
            self.button_upper,
        },
    );

    if (!combine)
        self.send(self.packetUnlocked());
}

pub fn setStick(self: *Controller, stick: mod.StickType, x: i8, y: i8) void {
    self.mutex.lockUncancelable();
    defer self.mutex.unlock();

    self.setStickUnlocked(stick, x, y);
}

pub fn setStickUnlocked(self: *Controller, stick: mod.StickType, x: i8, y: i8) void {
    log.debug(
        "set stick [{}] (x, y) = ({d}, {d})",
        .{ stick, x, y },
    );

    switch (stick) {
        .left_stick => self.left_stick_centre = calibratedPosition(x, y, self.left_stick_calibration),
        .right_stick => self.right_stick_centre = calibratedPosition(x, y, self.right_stick_calibration),
    }

    self.send(self.packetUnlocked());
}

pub fn resetStick(self: *Controller, stick: mod.StickType) void {
    self.mutex.lockUncancelable();
    defer self.mutex.unlock();

    self.resetStickUnlocked(stick);
}

pub fn resetStickUnlocked(self: *Controller, stick: mod.StickType) void {
    self.setStickUnlocked(stick, 0, 0);

    self.send(self.packetUnlocked());
}

pub fn resetButton(self: *Controller) void {
    self.mutex.lockUncancelable();
    defer self.mutex.unlock();

    self.button_lower = 0;
    self.button_shared = 0;
    self.button_upper = 0;

    self.send(self.packetUnlocked());
}

pub fn sleep(self: *Controller, ms: u32) void {
    const slice_ms = 20;
    var remains = ms;
    while (remains > slice_ms) {
        self._handler.sleep(slice_ms);
        remains -= slice_ms;
        self.send(self.packet());
    }
    if (remains > 0) {
        self._handler.sleep(remains);
    }
}

pub fn send(self: *Controller, report: ReportType) void {
    self._handler.send(report) catch |err| {
        log.err("failed to send packet: {s}", .{@errorName(err)});
    };
}

pub fn setHeartbeat(self: *Controller, flag: bool) void {
    self.heartbeat = flag;
}

pub fn heartbeatLoop(self: *Controller, comptime every_ms: u16) void {
    while (true) {
        if (self.heartbeat and !self._handler.send_report_flag) {
            log.debug("send heartbeat", .{});
            self._handler.send(.{ .incoming = null }) catch {};
        }
        self._handler.resetSendFlag();
        self._handler.sleep(every_ms);
    }
}

/// set button bit. if state is press then set bit to `1`, else set bit to `0`.
fn setButtonBit(byte: u8, mask: u8, state: mod.ButtonState) u8 {
    return switch (state) {
        .down => byte | mask,
        .up => byte & ~mask,
    };
}

test "setButtonBit" {
    try ExpectEqual(0x01, setButtonBit(0x00, 0x01, .down));
    try ExpectEqual(0xA2, setButtonBit(0xA3, 0x01, .up));
    try ExpectEqual(0xA3, setButtonBit(0xA3, 0x01, .down));
    try ExpectEqual(0xA3, setButtonBit(0xB3, 0x10, .up));
}

fn calibratedPositionInner(x: f32, y: f32, calibration: StickCalibration) [3]u8 {
    const fx = @as(f32, @floatFromInt(calibration.center_x)) + @abs(x) *
        if (x < 0)
            @as(f32, @floatFromInt(calibration.min_x))
        else
            @as(f32, @floatFromInt(calibration.max_x));

    const fy = @as(f32, @floatFromInt(calibration.center_y)) + @abs(y) *
        if (y < 0)
            @as(f32, @floatFromInt(calibration.min_y))
        else
            @as(f32, @floatFromInt(calibration.max_y));

    const ix = @as(i16, @intFromFloat(@round(fx)));
    const iy = @as(i16, @intFromFloat(@round(fy)));

    const ux: u16 = @intCast(@as(i16, std.math.clamp(ix, 0, std.math.maxInt(u12))));
    const uy: u16 = @intCast(@as(i16, std.math.clamp(iy, 0, std.math.maxInt(u12))));

    return .{
        @truncate(ux),
        @truncate((((uy & 0x0F) << 4) | (ux >> 8) & 0x0F)),
        @truncate(uy >> 4),
    };
}

pub fn calibratedPosition(x: i8, y: i8, calibration: StickCalibration) [3]u8 {
    return calibratedPositionInner(
        std.math.clamp(@as(f32, @floatFromInt(x)) / 100.0, -1.0, 1.0),
        std.math.clamp(@as(f32, @floatFromInt(y)) / 100.0, -1.0, 1.0),
        calibration,
    );
}

test "test calibratedPosition" {
    const result = calibratedPosition(-1.5, 0, .{
        .center_x = 2070,
        .center_y = 2013,
        .min_x = -1522,
        .max_x = 1414,
        .min_y = -1531,
        .max_y = 1510,
    });
    std.debug.print("{x}\n", .{result[0..]});
}
