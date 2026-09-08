pub const ReportTag = enum {
    incoming,
    sending,
    input,
    sleep,
    stop,
};

pub const ReportType = union(ReportTag) {
    incoming: ?[]u8,
    sending: []u8,
    input: struct {
        upper: u8 = 0,
        shared: u8 = 0,
        lower: u8 = 0,
        left_stick_centre: [3]u8 = [_]u8{ 0, 0, 0 },
        right_stick_centre: [3]u8 = [_]u8{ 0, 0, 0 },
    },
    sleep: usize,
    stop,
};
