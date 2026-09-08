pub const idf = @import("esp_idf");
pub const sys = idf.sys;
pub const bt = @import("bluetooth.zig");
pub const wifi = @import("wifi.zig");
pub const config = @import("config.zig");
pub const protocol = @import("protocol");
pub const http = @import("http.zig");
pub const http_action = @import("http_action.zig");
pub const Queue = @import("queue.zig").Queue;
pub const controller = @import("controller");
pub const Mutex = @import("mutex");

pub const report = @import("report");
pub const report_queue = @import("report_queue.zig");

pub const ReportQueue = report_queue.ReportQueue(64);

const std = @import("std");
pub const Configuration = struct {
    pub const Keys = enum {
        wf,
    };
    pub const WifiConfig = struct {
        pub const Auth = struct {
            ssid: []const u8 = "",
            pwd: []const u8 = "",
        };
        ap: Auth = .{},
        sta: Auth = .{},
    };

    pub const CommandsConfig = struct {
        pub const Entry = struct {
            remark: []const u8 = undefined,
            bytecode: []const u8 = undefined,
        };

        auto_start: bool = false,
        idx: u32 = 0,
        len: u32 = 0,
        cmds: []Entry = undefined,
    };
};
