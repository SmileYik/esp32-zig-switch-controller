const std = @import("std");
const protocol = @import("root.zig");

const Constants = protocol.Constants;
const Report = protocol.Report;
const SwitchReportParser = protocol.SwitchReportParser;

const sys = protocol.idf.sys;
const log = std.log.scoped(.switch_controller);

pub const Protocol = @This();
const VIBRATOR_BYTES = [_]u8{ 0xA0, 0xB0, 0xC0, 0x90 };

pub const Options = struct {
    controller_type: Constants.ControllerType,
    bt_address_mac: [6]u8,
    colour_body: [3]u8 = [_]u8{ 0x82, 0x82, 0x82 },
    colour_buttons: [3]u8 = [_]u8{ 0x0F, 0x0F, 0x0F },
    parser: SwitchReportParser,
};

parser: SwitchReportParser,

bt_address: [6]u8,
controller_type: Constants.ControllerType,
report: [Constants.MAX_REPORT_SIZE]u8,

mode: ?Constants.InputReportMode = null,
player_number: ?u8 = null,
device_info_queried: bool = false,

timer: std.atomic.Value(u8) = .init(0),

battery_level: u8 = 0x90,
connection_info: u8,

button_status: [3]u8 = [_]u8{ 0, 0, 0 },
left_stick_centre: [3]u8,
right_stick_centre: [3]u8,

vibration_enabled: bool = false,
vibrator_report: u8 = 0xA0,

imu_enabled: bool = false,

colour_body: [3]u8,
colour_buttons: [3]u8,

response: protocol.Constants.SwitchResponse = .no_data,

pub fn init(opt: Options) Protocol {
    var self = Protocol{
        .parser = opt.parser,
        .bt_address = opt.bt_address_mac,
        .controller_type = opt.controller_type,
        .report = undefined,
        .connection_info = opt.controller_type.connectionInfo(),
        .left_stick_centre = if (opt.controller_type == .joycon_r) [_]u8{ 0, 0, 0 } else [_]u8{ 0x6F, 0xC8, 0x77 },
        .right_stick_centre = if (opt.controller_type == .joycon_l) [_]u8{ 0, 0, 0 } else [_]u8{ 0x16, 0xD8, 0x7D },
        .colour_body = opt.colour_body,
        .colour_buttons = opt.colour_buttons,
    };
    self.setEmptyReport();
    return self;
}

/// get current report buffer array. you should invoke `clearReport()` method after you send this report.
pub fn getReport(self: *Protocol) *[Constants.MAX_REPORT_SIZE]u8 {
    return &self.report;
}

/// dupe report to your buf and clear self report.
pub fn bufReport(self: *Protocol, dest: *[Constants.MAX_REPORT_SIZE]u8) void {
    @memcpy(dest, &self.report);
    self.setEmptyReport();
}

/// allocate and dupe self report and return
pub fn allocReport(self: *Protocol, allocator: std.mem.Allocator) ![]u8 {
    var report = try allocator.alloc(u8, Constants.MAX_REPORT_SIZE);
    self.bufReport(report[0..Constants.MAX_REPORT_SIZE]);
    return report;
}

/// you should invoke this method after get and send report.
pub fn clearReport(self: *Protocol) void {
    self.setEmptyReport();
}

fn setEmptyReport(self: *Protocol) void {
    @memset(&self.report, 0);
    self.report[0] = 0xA1;
}

pub fn processCommands(self: *Protocol, data: []const u8) void {
    const message = self.parser.parse(data);
    self.response = message.response;

    switch (message.response) {
        .request_device_info => {
            self.device_info_queried = true;
            self.setSubcommandReply();
            self.setDeviceInfo();
        },
        .set_shipment => {
            self.setSubcommandReply();
            self.setShipment();
        },
        .spi_read => {
            self.setSubcommandReply();
            self.spiRead(message);
        },
        .set_mode => {
            self.setSubcommandReply();
            self.setMode(message);
        },
        .trigger_buttons => {
            self.setSubcommandReply();
            self.setTriggerButtons();
        },
        .toggle_imu => {
            self.setSubcommandReply();
            self.toggleImu(message);
        },
        .enable_vibration => {
            self.setSubcommandReply();
            self.enableVibration();
        },
        .set_player => {
            self.setSubcommandReply();
            self.setPlayerLights(message);
        },
        .set_nfc_ir_state => {
            self.setSubcommandReply();
            self.setNfcIrState();
        },
        .set_nfc_ir_config => {
            self.setSubcommandReply();
            self.setNfcIrConfig();
        },
        .no_data, .too_short, .malformed, _ => {
            self.setFullInputReport();
        },
    }
}

pub fn setSubcommandReply(self: *Protocol) void {
    self.report[1] = 0x21;
    self.vibrator_report = getRandomVibratorByte();
    self.setStandardInputReport();
}

pub fn setUnknownSubcommand(self: *Protocol, subcommand_id: u8) void {
    self.report[15] = subcommand_id;
}

pub fn nextTimer(self: *Protocol) void {
    _ = self.timer.fetchAdd(1, .release);
}

pub fn setTimer(self: *Protocol) void {
    self.report[2] = self.timer.load(.acquire);
}

pub fn setFullInputReport(self: *Protocol) void {
    self.report[1] = 0x30;
    self.setStandardInputReport();
    self.setImuData();
}

pub fn setStandardInputReport(self: *Protocol) void {
    self.setTimer();

    if (self.device_info_queried) {
        self.report[3] = self.battery_level | self.connection_info;

        // 2. 利用切片与 @memcpy 一次性写入连续数据，杜绝逐项赋值
        @memcpy(self.report[4..7], &self.button_status);
        @memcpy(self.report[7..10], &self.left_stick_centre);
        @memcpy(self.report[10..13], &self.right_stick_centre);

        self.report[13] = self.vibrator_report;
    }
}

pub fn setButtonInputs(self: *Protocol, upper: u8, shared: u8, lower: u8) void {
    @memcpy(self.report[4..7], &[_]u8{ upper, shared, lower });
}

pub fn setLeftStickInputs(self: *Protocol, left: [3]u8) void {
    @memcpy(self.report[7..10], &left);
}

pub fn setRightStickInputs(self: *Protocol, right: [3]u8) void {
    @memcpy(self.report[10..13], &right);
}

pub fn setDeviceInfo(self: *Protocol) void {
    @memcpy(self.report[14..20], &[_]u8{
        // ACK
        0x82,
        // Subcommand Reply
        0x02,
        // Firmware Major
        0x03,
        // Firmware Minor
        0x8B,
        // Unknown
        @intFromEnum(self.controller_type),
        0x02,
    });

    // mac
    @memcpy(self.report[20..26], &self.bt_address);
    // Unknown and Colours Location
    @memcpy(self.report[26..28], &[_]u8{0x01} ** 2);
}

pub fn setShipment(self: *Protocol) void {
    self.report[14] = 0x80;
    self.report[15] = 0x08;
}

pub fn toggleImu(self: *Protocol, message: Report) void {
    if (message.subcommand.len > 1 and message.subcommand[1] == 0x01) {
        self.imu_enabled = true;
    } else {
        self.imu_enabled = false;
    }
    self.report[14] = 0x80;
    self.report[15] = 0x40;
}

pub fn setImuData(self: *Protocol) void {
    if (!self.imu_enabled) return;
    @memcpy(self.report[14 .. 14 + Constants.IMU_DATA.len], &Constants.IMU_DATA);
}

pub fn spiRead(self: *Protocol, message: Report) void {
    if (message.subcommand.len < 6) return;

    const addr_bottom = message.subcommand[1];
    const addr_top = message.subcommand[2];
    const read_length = message.subcommand[5];

    // ACK
    self.report[14] = 0x90;
    // Subcommand reply
    self.report[15] = 0x10;
    self.report[16] = addr_bottom;
    self.report[17] = addr_top;
    self.report[20] = read_length;

    var params = [_]u8{
        0x0F, 0x30, 0x61,
        0x96, 0x30, 0xF3,
        0xD4, 0x14, 0x54,
        0x41, 0x15, 0x54,
        0xC7, 0x79, 0x9C,
        0x33, 0x36, 0x63,
    };

    if (self.controller_type != .pro_controller) {
        params[3] = 0xAE;
    }

    if (addr_top == 0x60 and addr_bottom == 0x00) {
        @memset(self.report[21 .. 21 + 16], 0xFF);
    } else if (addr_top == 0x60 and addr_bottom == 0x50) {
        @memcpy(self.report[21 .. 21 + self.colour_body.len], &self.colour_body);
        @memcpy(self.report[24 .. 24 + self.colour_buttons.len], &self.colour_buttons);
        @memset(self.report[27 .. 27 + 7], 0xFF);
    } else if (addr_top == 0x60 and addr_bottom == 0x80) {
        const payload = switch (self.controller_type) {
            .pro_controller => [_]u8{ 0x50, 0xFD, 0x00, 0x00, 0xC6, 0x0F },
            .joycon_l => [_]u8{ 0x5E, 0x01, 0x00, 0x00, 0xF1, 0x0F },
            .joycon_r => [_]u8{ 0x5E, 0x01, 0x00, 0x00, 0x0F, 0xF0 },
        };
        @memcpy(self.report[21..27], &payload);
    } else if (addr_top == 0x60 and addr_bottom == 0x98) {
        @memcpy(self.report[21..][0..params.len], &params);
    } else if (addr_top == 0x80 and addr_bottom == 0x10) {
        @memset(self.report[21..25], 0xFF);
    } else if (addr_top == 0x60 and addr_bottom == 0x3D) {
        if (self.controller_type != .joycon_r) {
            @memcpy(self.report[21..30], &Constants.L_CALIBRATION);
        } else {
            @memset(self.report[21..30], 0xFF);
        }

        if (self.controller_type != .joycon_l) {
            @memcpy(self.report[30..39], &Constants.R_CALIBRATION);
        } else {
            @memset(self.report[30..39], 0xFF);
        }

        self.report[39] = 0xFF;
        @memcpy(self.report[40..43], &self.colour_body);
        @memcpy(self.report[43..46], &self.colour_buttons);
    } else if (addr_top == 0x60 and addr_bottom == 0x20) {
        @memcpy(self.report[21 .. 21 + Constants.SA_CALIBRATION.len], &Constants.SA_CALIBRATION);
    }
}

pub fn setMode(self: *Protocol, message: Report) void {
    const data = [_]u8{ 0x80, 0x03 };
    @memcpy(self.report[14..16], &data);

    if (message.subcommand.len > 1) {
        self.mode = switch (message.subcommand[1]) {
            0x30 => .standard,
            0x31 => .nfc_ir,
            0x3F => .simple_hid,
            else => self.mode,
        };
    }
}

pub fn setTriggerButtons(self: *Protocol) void {
    self.report[14] = 0x83;
    self.report[15] = 0x04;
}

pub fn enableVibration(self: *Protocol) void {
    self.report[14] = 0x82;
    self.report[15] = 0x48;
    self.vibration_enabled = true;
}

pub fn setPlayerLights(self: *Protocol, message: Report) void {
    const data = [_]u8{ 0x80, 0x30 };
    @memcpy(self.report[14..16], &data);

    if (message.subcommand.len > 1) {
        switch (message.subcommand[1]) {
            0x01, 0x10 => self.player_number = 1,
            0x03, 0x30 => self.player_number = 2,
            0x07, 0x70 => self.player_number = 3,
            0x0F, 0xF0 => self.player_number = 4,
            else => {}, // 收到未知 bitfield 时保持原 player_number 不变
        }
    }
}

pub fn setNfcIrState(self: *Protocol) void {
    const data = [_]u8{ 0x80, 0x22 };
    @memcpy(self.report[14..16], &data);
}

pub fn setNfcIrConfig(self: *Protocol) void {
    const payload = [_]u8{
        0xA0, // Header
        0x21, // Subcommand
        0x01, 0x00, 0xFF, 0x00, 0x08, 0x00, 0x1B, 0x01, // Params
    };
    @memcpy(self.report[14..24], &payload);

    self.report[49] = 0xC8;
}

fn getRandomVibratorByte() u8 {
    const rand_idx = @as(usize, @intCast(sys.esp_random() % VIBRATOR_BYTES.len));
    return VIBRATOR_BYTES[rand_idx];
}

pub fn combine(masks: anytype) u8 {
    var mask: u8 = 0;
    inline for (masks) |bit| {
        mask |= @intFromEnum(bit);
    }
    return mask;
}
