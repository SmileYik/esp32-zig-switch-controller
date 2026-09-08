const std = @import("std");
const builtin = @import("builtin");
const mod = @import("root.zig");
const sys = mod.sys;
const bt = mod.idf.bt;
const log = std.log.scoped(.bluetooth);
const errors = mod.idf.err;
const Allocator = std.mem.Allocator;
const Self = @This();

const BTError = error{
    SendReportFailed,
    SetMacAddressFailed,
    GAPRegisterCallbackFailed,
    GAPSetCODFailed,
    GAPSetSecurityParamFailed,
    GAPSetDeviceNameFailed,
    HIDDRegisterCallbackFailed,
    HIDDInitFailed,
    EnablePairingFailed,
    SendWrongReport,
};

// ----------------------------
// HIDD Things....
// ----------------------------

pub const HIDDType = enum(c_int) {
    init = sys.ESP_HIDD_INIT_EVT,
    register_app = sys.ESP_HIDD_REGISTER_APP_EVT,
    open = sys.ESP_HIDD_OPEN_EVT,
    close = sys.ESP_HIDD_CLOSE_EVT,
    intr = sys.ESP_HIDD_INTR_DATA_EVT,
    send_report = sys.ESP_HIDD_SEND_REPORT_EVT,
};

pub const HIDDEvent = union(HIDDType) {
    init: ?*const sys.struct_hidd_init_evt_param_183,
    register_app: ?*const sys.struct_hidd_register_app_evt_param_185,
    open: ?*const sys.struct_hidd_open_evt_param_187,
    close: ?*const sys.struct_hidd_close_evt_param_188,
    intr: ?*const sys.struct_hidd_intr_data_evt_param_194,
    send_report: ?*const sys.struct_hidd_send_report_evt_param_189,
};

pub const HIDDCallback = *const fn (event: HIDDEvent) void;

const HID_REPORT_DESCRIPTOR = [_:0]u8{
    0x05, 0x01, 0x09, 0x05, 0xa1, 0x01, 0x06, 0x01, 0xff, 0x85, 0x21, 0x09,
    0x21, 0x75, 0x08, 0x95, 0x30, 0x81, 0x02, 0x85, 0x30, 0x09, 0x30, 0x75,
    0x08, 0x95, 0x30, 0x81, 0x02, 0x85, 0x31, 0x09, 0x31, 0x75, 0x08, 0x96,
    0x69, 0x01, 0x81, 0x02, 0x85, 0x32, 0x09, 0x32, 0x75, 0x08, 0x96, 0x69,
    0x01, 0x81, 0x02, 0x85, 0x33, 0x09, 0x33, 0x75, 0x08, 0x96, 0x69, 0x01,
    0x81, 0x02, 0x85, 0x3f, 0x05, 0x09, 0x19, 0x01, 0x29, 0x10, 0x15, 0x00,
    0x25, 0x01, 0x75, 0x01, 0x95, 0x10, 0x81, 0x02, 0x05, 0x01, 0x09, 0x39,
    0x15, 0x00, 0x25, 0x07, 0x75, 0x04, 0x95, 0x01, 0x81, 0x42, 0x05, 0x09,
    0x75, 0x04, 0x95, 0x01, 0x81, 0x01, 0x05, 0x01, 0x09, 0x30, 0x09, 0x31,
    0x09, 0x33, 0x09, 0x34, 0x16, 0x00, 0x00, 0x27, 0xff, 0xff, 0x00, 0x00,
    0x75, 0x10, 0x95, 0x04, 0x81, 0x02, 0x06, 0x01, 0xff, 0x85, 0x01, 0x09,
    0x01, 0x75, 0x08, 0x95, 0x30, 0x91, 0x02, 0x85, 0x10, 0x09, 0x10, 0x75,
    0x08, 0x95, 0x30, 0x91, 0x02, 0x85, 0x11, 0x09, 0x11, 0x75, 0x08, 0x95,
    0x30, 0x91, 0x02, 0x85, 0x12, 0x09, 0x12, 0x75, 0x08, 0x95, 0x30, 0x91,
    0x02, 0xc0,
};

// ----------------------------
// GAP things
// ----------------------------

const GAP_COD: u32 = 0x002508;

pub const Options = struct {
    mac: [6]u8,
    name: []const u8 = "Pro Controller",
    description: []const u8 = "Gamepad",
    provider: []const u8 = "Nintendo",
    send_report_offset: u8 = 0,

    /// any struct type pointer,
    /// if this struct include `fn (self: Self, event: HIDDEvent) void` that means will subscribe hidd event.
    handler: ?*anyopaque = null,
};

// -------------------------------
// handler interface
// --------------------------------

const HandlerInterface = struct {
    ctx: *anyopaque,
    handleHIDDFn: ?*const fn (ctx: *anyopaque, event: HIDDEvent) void = null,

    pub fn init(handler: anytype) HandlerInterface {
        var interface: HandlerInterface = .{ .ctx = handler };

        const Pointer = @TypeOf(handler);
        comptime {
            const info = @typeInfo(Pointer);
            if (info != .pointer or info.pointer.size != .one) {
                @panic("Handler need be a container pointer");
            }
        }
        if (std.meta.hasMethod(Pointer, "handleHIDD")) {
            interface.handleHIDDFn = (struct {
                fn handle(ctx: *anyopaque, event: HIDDEvent) void {
                    var ptr: Pointer = @ptrCast(@alignCast(ctx));
                    ptr.handleHIDD(event);
                }
            }).handle;
        }

        return interface;
    }
};

var INSTANCE: ?*Self = null;
var not_free_ble = true;

allocator: Allocator,

mac: [6]u8,
name: []const u8,
description: []const u8,
provider: []const u8,
send_report_offset: u8,
handler: HandlerInterface,
hidd_app_param: sys.esp_hidd_app_param_t,
hidd_qos_in: sys.esp_hidd_qos_param_t,
hidd_qos_out: sys.esp_hidd_qos_param_t,

/// param `handler` should be a pointer struct type.
pub fn init(allocator: Allocator, handler: anytype, opt: Options) !*Self {
    const instance: *Self = try allocator.create(Self);
    errdefer allocator.destroy(instance);
    const name: [:0]const u8 = try allocator.dupeZ(u8, opt.name);
    errdefer allocator.free(name);
    const description: [:0]const u8 = try allocator.dupeZ(u8, opt.description);
    errdefer allocator.free(description);
    const provider: [:0]const u8 = try allocator.dupeZ(u8, opt.provider);
    errdefer allocator.free(provider);

    instance.* = .{
        .allocator = allocator,
        .mac = opt.mac,
        .name = name,
        .description = description,
        .provider = provider,
        .send_report_offset = opt.send_report_offset,
        .handler = HandlerInterface.init(handler),
        .hidd_app_param = .{
            .name = instance.name.ptr,
            .description = instance.description.ptr,
            .provider = instance.provider.ptr,
            .subclass = 0x08,
            .desc_list = @constCast(&HID_REPORT_DESCRIPTOR),
            .desc_list_len = HID_REPORT_DESCRIPTOR.len,
        },
        .hidd_qos_in = .{
            .service_type = 0x01,
            .token_rate = 0,
            .token_bucket_size = 0,
            .peak_bandwidth = 0,
            .delay_variation = 0,
            .access_latency = 0,
        },
        .hidd_qos_out = .{
            .service_type = 0x01,
            .token_rate = 0,
            .token_bucket_size = 0,
            .peak_bandwidth = 0,
            .delay_variation = 0,
            .access_latency = 0,
        },
    };
    if (INSTANCE) |ins| ins.deinit();
    errdefer instance.deinit();

    INSTANCE = instance;
    errdefer {
        INSTANCE = null;
    }
    try instance.start();
    return instance;
}

pub fn deinit(self: *Self) void {
    errors.espCheckError(sys.esp_bt_hid_device_deinit()) catch |e| {
        log.err("deinit hid device failed: {s}", .{@errorName(e)});
    };
    classicDeinit() catch {};

    // clean
    INSTANCE = null;
    self.allocator.free(self.name);
    self.allocator.free(self.provider);
    self.allocator.free(self.description);
    self.allocator.destroy(self);
}

pub fn enablePairing(_: *Self) !void {
    errors.espCheckError(sys.esp_bt_gap_set_scan_mode(
        sys.ESP_BT_CONNECTABLE,
        sys.ESP_BT_GENERAL_DISCOVERABLE,
    )) catch |e| {
        log.err("change scan mode to connectable and discoverable failed: {s}", .{@errorName(e)});
        return BTError.EnablePairingFailed;
    };
}

fn start(self: *Self) !void {
    classicInit(self.mac) catch |err| {
        log.err("Classic BT initialization failed: {s}", .{@errorName(err)});
        return err;
    };

    try setGapRegisterCallback(&gapCallback);

    errors.espCheckError(esp_bt_gap_set_cod(GAP_COD, sys.ESP_BT_SET_COD_ALL)) catch |e| {
        log.err("GAP set COD failed: {s}", .{@errorName(e)});
        return BTError.GAPSetCODFailed;
    };

    errors.espCheckError(sys.esp_bt_gap_set_security_param(
        sys.ESP_BT_SP_IOCAP_MODE,
        @constCast(&sys.ESP_BT_IO_CAP_NONE),
        @sizeOf(sys.esp_bt_io_cap_t),
    )) catch |e| {
        log.err("GAP set security param failed: {s}", .{@errorName(e)});
        return BTError.GAPSetSecurityParamFailed;
    };

    errors.espCheckError(sys.esp_bt_gap_set_device_name(self.name.ptr)) catch |e| {
        log.err("GAP set device name failed: {s}", .{@errorName(e)});
        return BTError.GAPSetDeviceNameFailed;
    };

    try setHidDeviceRegisterCallback(&hiddCallback);

    errors.espCheckError(sys.esp_bt_hid_device_init()) catch |e| {
        log.err("HIDD init failed: {s}", .{@errorName(e)});
        return BTError.HIDDInitFailed;
    };
}

fn setGapRegisterCallback(callback: sys.esp_bt_gap_cb_t) !void {
    errors.espCheckError(sys.esp_bt_gap_register_callback(callback)) catch |e| {
        log.err("GAP register callback failed: {s}", .{@errorName(e)});
        return BTError.GAPRegisterCallbackFailed;
    };
}

fn setHidDeviceRegisterCallback(callback: sys.esp_hd_cb_t) !void {
    errors.espCheckError(sys.esp_bt_hid_device_register_callback(callback)) catch |e| {
        log.err("HIDD register callback failed: {s}", .{@errorName(e)});
        return BTError.HIDDRegisterCallbackFailed;
    };
}

fn callHIDDHandler(self: *Self, event: HIDDEvent) void {
    if (self.handler.handleHIDDFn) |handle| {
        handle(self.handler.ctx, event);
    }
}

pub fn sendReport(self: *Self, data: []u8) !void {
    log.debug("send report [len={d}]: {x}", .{ data.len, data });
    if (data.len <= self.send_report_offset + 1) {
        return BTError.SendWrongReport;
    }

    const report_id = data[self.send_report_offset];
    const payload = data[self.send_report_offset + 1 ..];
    errors.espCheckError(sys.esp_bt_hid_device_send_report(
        sys.ESP_HIDD_REPORT_TYPE_INTRDATA,
        report_id,
        @intCast(payload.len),
        payload.ptr,
    )) catch |e| {
        log.err("send report failed: {s}", .{@errorName(e)});
        return BTError.SendReportFailed;
    };
}

fn classicInit(mac: [6]u8) !void {
    errors.espCheckError(sys.esp_base_mac_addr_set(&mac)) catch |e| {
        log.err("set mac address failed: {s}", .{@errorName(e)});
        return BTError.SetMacAddressFailed;
    };

    var cfg = bt.Controller.defaultConfig();
    if (not_free_ble) {
        not_free_ble = false;
        try bt.Controller.memRelease(.ble);
    }
    try bt.Controller.init(&cfg);
    try bt.Controller.enable(.classic);
    try bt.Bluedroid.init();
    try bt.Bluedroid.enable();
}

fn classicDeinit() !void {
    try bt.Bluedroid.disable();
    try bt.Bluedroid.deinit();
    try bt.Controller.disable();
    try bt.Controller.deinit();
}

export fn hiddCallback(
    event: sys.esp_hidd_cb_event_t,
    param: [*c]sys.esp_hidd_cb_param_t,
) callconv(.c) void {
    if (INSTANCE) |ins| {
        switch (event) {
            sys.ESP_HIDD_INIT_EVT => {
                log.debug("[HIDD] [INIT] prepare to init", .{});
                errors.espCheckError(sys.esp_bt_hid_device_register_app(
                    @constCast(&ins.hidd_app_param),
                    @constCast(&ins.hidd_qos_in),
                    @constCast(&ins.hidd_qos_out),
                )) catch |e| {
                    log.err("[HIDD] [INIT] failed to init: {s}", .{@errorName(e)});
                };
                ins.callHIDDHandler(.{ .init = if (param == null) null else &param.*.init });
            },

            sys.ESP_HIDD_REGISTER_APP_EVT => {
                log.debug("[HIDD] [REGISTER_APP] wating for paring", .{});
                ins.enablePairing() catch {};
                ins.callHIDDHandler(.{ .register_app = if (param == null) null else &param.*.register_app });
            },

            sys.ESP_HIDD_OPEN_EVT => {
                log.debug("[HIDD] [OPEN] connecting", .{});

                ins.callHIDDHandler(.{ .open = if (param == null) null else &param.*.open });
            },

            sys.ESP_HIDD_CLOSE_EVT => {
                log.warn("[HIDD] [CLOSE] closing", .{});

                ins.enablePairing() catch {};
                ins.callHIDDHandler(.{ .close = if (param == null) null else &param.*.close });
            },

            sys.ESP_HIDD_INTR_DATA_EVT => {
                ins.callHIDDHandler(.{ .intr = if (param == null) null else &param.*.intr_data });

                if (builtin.mode == .Debug) {
                    if (param != null and param.*.intr_data.data != null) {
                        const intr = param.*.intr_data;
                        log.debug(
                            "[HIDD] [INTR] [len={d}] [id={x}]: {x}",
                            .{
                                intr.len,
                                intr.report_id,
                                intr.data[0..intr.len],
                            },
                        );
                    }
                }
            },

            sys.ESP_HIDD_SEND_REPORT_EVT => {
                ins.callHIDDHandler(.{ .send_report = if (param == null) null else &param.*.send_report });
            },

            else => {},
        }
    }
}

/// re-export this function.
extern fn esp_bt_gap_set_cod(cod: u32, mode: sys.esp_bt_cod_mode_t) callconv(.c) sys.esp_err_t;

export fn gapCallback(
    event: sys.esp_bt_gap_cb_event_t,
    param: [*c]sys.esp_bt_gap_cb_param_t,
) callconv(.c) void {
    switch (event) {
        sys.ESP_BT_GAP_CFM_REQ_EVT => {
            log.debug("[GAP] [ESP_BT_GAP_CFM_REQ_EVT] Accepted!", .{});
            const bda = &param.*.cfm_req.bda;
            errors.espCheckError(sys.esp_bt_gap_ssp_confirm_reply(@ptrCast(@alignCast(bda)), true)) catch |e| {
                log.err("[GAP] [ESP_BT_GAP_CFM_REQ_EVT] auto accept failed: {s}", .{@errorName(e)});
            };
        },

        sys.ESP_BT_GAP_AUTH_CMPL_EVT => {
            if (param.*.auth_cmpl.stat == sys.ESP_BT_STATUS_SUCCESS) {
                log.debug("[GAP] [ESP_BT_GAP_AUTH_CMPL_EVT] auth success！", .{});
            } else {
                log.warn("[GAP] [ESP_BT_GAP_AUTH_CMPL_EVT] auth status: {d}", .{param.*.auth_cmpl.stat});
            }
        },

        sys.ESP_BT_GAP_PIN_REQ_EVT => {
            log.debug("[GAP] [ESP_BT_GAP_PIN_REQ_EVT] Requesting PIN, responsing 0000...", .{});
            var pin_code = [_]u8{ '0', '0', '0', '0' };
            errors.espCheckError(sys.esp_bt_gap_pin_reply(
                @ptrCast(@alignCast(&param.*.pin_req.bda)),
                true,
                4,
                &pin_code[0],
            )) catch |e| {
                log.err("[GAP] [ESP_BT_GAP_PIN_REQ_EVT] auto respone PIN failed: {s}", .{@errorName(e)});
            };
        },

        else => {},
    }
}
