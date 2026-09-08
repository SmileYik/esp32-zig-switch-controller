const std = @import("std");
const Allocator = std.mem.Allocator;
const builtin = @import("builtin");
const mod = @import("mod");
const idf = mod.idf;
const sys = idf.sys;
const bt = mod.bt;

const ControllerProtocol = mod.protocol.Protocol;
const log = std.log.scoped(.switch_controller);

const switch_mac = [_]u8{ 0x7C, 0xBB, 0x8A, 0x77, 0x88, 0x9C };
var protocol = ControllerProtocol.init(.{
    .controller_type = .pro_controller,
    .bt_address_mac = switch_mac,
    .parser = .{
        .data_len = 48,
        .magic_head = null,
        .payload_len = 9,
    },
});

const ReportSender = struct {
    report_queue: *mod.ReportQueue,

    pub fn send(self: *ReportSender, report: mod.report.ReportType) !void {
        try self.report_queue.enqueueWait(report, idf.rtos.msToTicks(3000));
    }

    pub fn sleep(_: *ReportSender, ms: u32) void {
        idf.rtos.Task.delayMs(ms);
    }
};

// ---------------------------------------------------------------------------
// 6. 初始化与 app_main
// ---------------------------------------------------------------------------
export fn app_main() callconv(.c) void {
    var heap = idf.heap.HeapCapsAllocator.init(.{ .@"8bit" = true });

    // var arena = std.heap.ArenaAllocator.init(heap.allocator());
    // defer arena.deinit();
    const allocator = heap.allocator();

    log.info("----------------- memory: {d}/{d}", .{ heap.freeSize(), heap.totalSize() });

    idf.nvs.flashInitOrErase() catch |err| {
        log.err("NVS 初始化失败: {s}", .{@errorName(err)});
        return;
    };

    // load wifi
    var wifi_config = mod.config.loadStruct(
        allocator,
        "wf",
        mod.Configuration.WifiConfig,
    ) catch mod.config.DefaultConfig(mod.Configuration.WifiConfig{});
    var wifi = mod.wifi.WifiManager.init(
        allocator,
        &.{ .ssid = wifi_config.config.ap.ssid, .password = wifi_config.config.ap.pwd },
        &.{ .ssid = wifi_config.config.sta.ssid, .password = wifi_config.config.sta.pwd },
    ) catch |err| {
        log.err("Wifi 初始化失败: {s}", .{@errorName(err)});
        return;
    };
    defer wifi.deinit();
    defer wifi.stopWifi() catch |err| {
        log.err("Wifi 关闭失败: {s}", .{@errorName(err)});
    };
    wifi.startWifi() catch |err| {
        log.err("Wifi 开启失败: {s}", .{@errorName(err)});
    };
    wifi_config.deinit();

    var http_srv = mod.http.init();
    defer http_srv.stop() catch |err| {
        log.err("Http Server 关闭失败: {s}", .{@errorName(err)});
    };
    http_srv.start() catch |err| {
        log.err("Http Server 开启失败: {s}", .{@errorName(err)});
    };

    var queue = mod.ReportQueue.init(
        allocator,
        .{ .protocol = protocol },
        .{
            .mac = switch_mac,
            .send_report_offset = 1,
        },
    ) catch |err| {
        log.err("初始化消息队列失败: {s}", .{@errorName(err)});
        return;
    };
    defer queue.deinit();
    queue.start() catch @panic("消息队列启动失败!");

    var controller_handler = ReportSender{
        .report_queue = queue,
    };

    var controller = mod.controller.Controller.init(
        allocator,
        &controller_handler,
        .{
            .heartbeat_rate_hz = 2,
        },
    ) catch |err| {
        log.err("控制器初始化失败!: {s}", .{@errorName(err)});
        return;
    };
    defer controller.deinit();

    var http_action = mod.http_action.init(
        allocator,
        controller,
        &heap,
        wifi,
    ) catch |err| {
        log.err("Http action 初始化失败: {s}", .{@errorName(err)});
        return;
    };
    http_srv.registerUris(http_action.getUris()) catch |err| {
        log.err("Http action 注册失败: {s}", .{@errorName(err)});
    };
    http_action.startConsume() catch |err| {
        log.err("Http action 队伍列表启动失败: {s}", .{@errorName(err)});
    };

    log.info("========== ESP32 Switch HID 手柄已启动 ==========", .{});

    _ = wifi.waitForConnect(60000);

    log.info("----------------- memory: {d}/{d}", .{ heap.freeSize(), heap.totalSize() });

    while (!queue.is_connected.load(.acquire)) {
        idf.rtos.Task.delayMs(1000);
    }

    // heartbeat loop
    controller.heartbeatLoop(500);
}

pub const panic = idf.esp_panic.panic;
pub const std_options: std.Options = .{
    .log_level = switch (builtin.mode) {
        .Debug => .debug,
        else => .info,
    },
    .logFn = idf.log.espLogFn,
};
