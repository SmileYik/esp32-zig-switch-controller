const std = @import("std");
const mod = @import("root.zig");

pub const StackFrame = struct {
    body_pc: usize,
    remaining_times: u32,
};

pub fn CallStackStatic(comptime cap: usize) type {
    return struct {
        const Self = @This();

        items: [cap]StackFrame = undefined,
        top_index: usize = 0,

        pub fn push(self: *Self, frame: StackFrame) !void {
            if (self.top_index >= cap)
                return error.StackOverflow;

            self.items[self.top_index] = frame;
            self.top_index += 1;
        }

        pub fn top(self: *Self) ?*StackFrame {
            return if (self.top_index > 0)
                &self.items[self.top_index - 1]
            else
                null;
        }

        pub fn pop(self: *Self) ?StackFrame {
            if (self.top_index == 0) return null;
            self.top_index -= 1;
            return self.items[self.top_index];
        }

        pub fn len(self: *const Self) usize {
            return self.top_index;
        }

        pub fn capacity(_: *const Self) usize {
            return capacity;
        }

        pub fn isEmpty(self: *const Self) bool {
            return self.top_index == 0;
        }

        pub fn clear(self: *Self) void {
            self.top_index = 0;
        }

        pub fn deinit(_: *Self) void {}
    };
}

pub const CallStackAlloc = struct {
    const Self = @This();

    allocator: std.mem.Allocator,
    items: std.ArrayList(StackFrame),

    pub fn init(allocator: std.mem.Allocator) Self {
        return .{
            .allocator = allocator,
            .items = .empty,
        };
    }

    pub fn deinit(self: *Self) void {
        self.items.deinit(self.allocator);
    }

    pub fn push(self: *Self, frame: StackFrame) !void {
        try self.items.append(self.allocator, frame);
    }

    pub fn top(self: *Self) ?*StackFrame {
        std.debug.assert(self.items.items.len > 0);
        return if (self.items.items.len > 0)
            &self.items.items[self.items.items.len - 1]
        else
            null;
    }

    pub fn pop(self: *Self) ?StackFrame {
        return self.items.pop();
    }

    pub fn len(self: *const Self) usize {
        return self.items.items.len;
    }

    pub fn capacity(self: *const Self) usize {
        return self.items.capacity;
    }

    pub fn isEmpty(self: *const Self) bool {
        return self.items.items.len == 0;
    }

    pub fn clear(self: *Self) void {
        self.items.clearRetainingCapacity();
    }
};

pub const ByteCodeReaderSafe = ByteCodeReader(true);
pub const ByteCodeReaderUnsafe = ByteCodeReader(false);

pub fn ByteCodeReader(comptime safe_mode: bool) type {
    return struct {
        const Self = @This();
        pc: usize = 0,
        bytecode: []const u8,
        bytecode_len: usize = 0,
        endian: std.builtin.Endian = .little,

        fn setPCNocheck(self: *Self, pc: usize) !void {
            self.pc = pc;
        }

        fn setPCSafe(self: *Self, pc: usize) !void {
            if (pc > self.bytecode_len) return error.PCOverflow;
            try self.setPCNocheck(pc);
        }

        fn addPCNocheck(self: *Self, add: usize) !void {
            self.pc += add;
        }

        fn addPCSafe(self: *Self, add: usize) !void {
            self.pc = try std.math.add(usize, self.pc, add);
            if (self.pc > self.bytecode_len) return error.PCOverflow;
        }

        fn setPC(self: *Self, pc: usize) !void {
            if (safe_mode) {
                try self.setPCSafe(pc);
            } else {
                try self.setPCNocheck(pc);
            }
        }

        fn addPC(self: *Self, add: usize) !void {
            if (safe_mode) {
                try self.addPCSafe(add);
            } else {
                try self.addPCNocheck(add);
            }
        }

        pub fn skipBytes(self: *Self, bytes: usize) !void {
            try self.addPC(bytes);
        }

        pub fn readInt(self: *Self, comptime T: type) !T {
            const type_size = @sizeOf(T);
            try self.addPC(type_size);
            return std.mem.readInt(
                T,
                self.bytecode[self.pc - type_size .. self.pc][0..type_size],
                self.endian,
            );
        }

        pub fn readFloat32(self: *Self) !f32 {
            return @bitCast(try self.readInt(u32));
        }

        pub fn readByte(self: *Self) !u8 {
            try self.addPC(1);
            const byte = self.bytecode[self.pc - 1];
            return byte;
        }

        pub fn readEnum(self: *Self, comptime T: type) !T {
            const t = comptime blk: {
                const info = @typeInfo(T);
                switch (info) {
                    .@"enum" => |e| {
                        const tag_info = @typeInfo(e.tag_type);
                        switch (tag_info) {
                            .int => break :blk e.tag_type,
                            else => @compileError("Not support type"),
                        }
                    },
                    else => @compileError("Only support enum type"),
                }
            };

            const value = try self.readInt(t);
            if (safe_mode) {
                inline for (@typeInfo(T).@"enum".fields) |field| {
                    if (field.value == value) {
                        return @enumFromInt(value);
                    }
                }
                return error.ReadWrongEnum;
            } else {
                return @enumFromInt(value);
            }
        }

        pub fn len(self: *Self) usize {
            return self.bytecode_len;
        }

        pub fn hasNext(self: *Self) bool {
            return self.pc < self.bytecode_len;
        }

        pub fn peekByte(self: *Self) !u8 {
            if (safe_mode) {
                if (self.hasNext())
                    return self.bytecode[self.pc];
                return error.PCOverflow;
            } else {
                return self.bytecode[self.pc];
            }
        }
    };
}

pub fn CommandRunner(comptime CallStack: type) type {
    return struct {
        const Self = @This();

        controller: *mod.Controller,
        stack: CallStack,

        pub fn deinit(self: *Self) void {
            self.stack.deinit();
        }

        pub fn runCommand(self: *Self, command: *const mod.command.Command) void {
            // log.info("run command {}", .{std.meta.activeTag(command.*)});
            switch (command.*) {
                .down => |b| self.controller.pressButton(b.button, .down, b.combine),
                .up => |b| self.controller.pressButton(b.button, .up, b.combine),
                .reset_all => {
                    self.controller.resetButton();
                    self.controller.resetStick(.left_stick);
                    self.controller.resetStick(.right_stick);
                },
                .reset_button => self.controller.resetButton(),
                .reset_stick => |stick| self.controller.resetStick(stick),
                .stick => |stick| self.controller.setStick(stick.stick, stick.x, stick.y),
                .wait => |ms| self.controller.sleep(ms),
                .wait_u16 => |ms| self.controller.sleep(@intCast(ms)),
                .wait_u8 => |ms| self.controller.sleep(@intCast(ms)),
                .commands => |*cs| self.runCommands(cs),
                .repeat => |*repeat| {
                    for (0..repeat.times) |_| {
                        self.runCommands(&repeat.commands);
                    }
                },
                else => {},
            }
        }

        pub fn runCommands(self: *Self, commands: *const mod.command.Commands) void {
            for (commands.items) |*item| {
                self.runCommand(item);
            }
        }

        pub fn runCommandPack(self: *Self, command_pack: *const mod.command.CommandPack) void {
            self.runCommands(&command_pack.commands);
        }

        pub fn runByteCode(self: *Self, bytecode: []const u8) !void {
            var reader = ByteCodeReaderSafe{
                .pc = 0,
                .bytecode = bytecode,
                .bytecode_len = bytecode.len,
            };
            if (!reader.hasNext()) {
                return;
            }
            const endian_byte = try reader.readByte();
            reader.endian = mod.byte2Endian(endian_byte);

            try self.runByteCodeInner(&reader);
        }

        pub fn runByteCodeUnsafe(self: *Self, bytecode: []const u8) !void {
            var reader = ByteCodeReaderUnsafe{
                .pc = 0,
                .bytecode = bytecode,
                .bytecode_len = bytecode.len,
            };
            if (!reader.hasNext()) {
                return;
            }
            const endian_byte = try reader.readByte();
            reader.endian = mod.byte2Endian(endian_byte);

            try self.runByteCodeInner(&reader);
        }

        fn runByteCodeInner(self: *Self, reader: anytype) !void {
            self.stack.clear();

            while (reader.hasNext()) {
                const tag: mod.command.CommandTag = try reader.readEnum(mod.command.CommandTag);
                switch (tag) {
                    .wait => {
                        const ms = try reader.readInt(u32);
                        self.controller.sleep(ms);
                    },
                    .wait_u16 => {
                        const ms = try reader.readInt(u16);
                        self.controller.sleep(@intCast(ms));
                    },
                    .wait_u8 => {
                        const ms = try reader.readByte();
                        self.controller.sleep(@intCast(ms));
                    },

                    .down => {
                        const button_byte = try reader.readByte();
                        const button = mod.byteToButton(button_byte);
                        self.controller.pressButton(button, .down, false);
                    },
                    .down_combine => {
                        const button_byte = try reader.readByte();
                        const combine = reader.hasNext() and
                            try reader.peekByte() == @intFromEnum(mod.command.CommandTag.down_combine);

                        const button = mod.byteToButton(button_byte);
                        self.controller.pressButton(button, .down, combine);
                    },

                    .up => {
                        const button_byte = try reader.readByte();
                        const button = mod.byteToButton(button_byte);
                        self.controller.pressButton(button, .up, false);
                    },
                    .up_combine => {
                        const button_byte = try reader.readByte();
                        const combine = reader.hasNext() and
                            try reader.peekByte() == @intFromEnum(mod.command.CommandTag.up_combine);

                        const button = mod.byteToButton(button_byte);
                        self.controller.pressButton(button, .up, combine);
                    },

                    .stick => {
                        const stick_type: mod.StickType = try reader.readEnum(mod.StickType);
                        const x: u8 = try reader.readByte();
                        const y: u8 = try reader.readByte();

                        self.controller.setStick(stick_type, @bitCast(x), @bitCast(y));
                    },

                    .reset_stick => {
                        const stick_type: mod.StickType = try reader.readEnum(mod.StickType);
                        self.controller.resetStick(stick_type);
                    },

                    .commands => {
                        try self.stack.push(.{
                            .body_pc = reader.pc,
                            .remaining_times = 0,
                        });
                    },

                    .repeat => {
                        const times = try reader.readInt(u32);
                        try reader.skipBytes(1);

                        try self.stack.push(.{
                            .body_pc = reader.pc,
                            .remaining_times = std.math.sub(u32, times, 1) catch 0,
                        });
                    },
                    .repeat_u16 => {
                        const times = try reader.readInt(u16);
                        try reader.skipBytes(1);

                        try self.stack.push(.{
                            .body_pc = reader.pc,
                            .remaining_times = std.math.sub(u32, times, 1) catch 0,
                        });
                    },
                    .repeat_u8 => {
                        const times = try reader.readByte();
                        try reader.skipBytes(1);

                        try self.stack.push(.{
                            .body_pc = reader.pc,
                            .remaining_times = std.math.sub(u32, times, 1) catch 0,
                        });
                    },

                    .reset_button => {
                        self.controller.resetButton();
                    },

                    .reset_all => {
                        self.controller.resetButton();
                        self.controller.resetStick(.left_stick);
                        self.controller.resetStick(.right_stick);
                    },

                    .end => {
                        if (self.stack.top()) |frame| {
                            if (frame.remaining_times > 0) {
                                try reader.setPC(frame.body_pc);
                                frame.remaining_times -= 1;
                            } else {
                                _ = self.stack.pop();
                            }
                        } else {
                            break;
                        }
                    },
                    else => {},
                }
            }
        }
    };
}

const NothingHandler = struct {
    const Self = @This();
    pub fn send(_: *Self, _: @import("report").ReportType) !void {}

    pub fn sleep(_: *Self, _: u32) void {}
};
const CallStackAllocTest = struct {
    const Self = @This();

    stack: CallStackAlloc,

    pub fn init(allocator: std.mem.Allocator) Self {
        return .{
            .stack = .{
                .allocator = allocator,
                .items = .empty,
            },
        };
    }

    pub fn deinit(self: *Self) void {
        self.stack.deinit();
    }

    pub fn push(self: *Self, frame: StackFrame) !void {
        try self.stack.push(.{
            .body_pc = frame.body_pc,
            .remaining_times = 0,
        });
    }

    pub fn top(self: *Self) ?*StackFrame {
        return self.stack.top();
    }

    pub fn pop(self: *Self) ?StackFrame {
        return self.stack.pop();
    }

    pub fn len(self: *const Self) usize {
        return self.stack.len();
    }

    pub fn capacity(self: *const Self) usize {
        return self.stack.capacity();
    }

    pub fn isEmpty(self: *const Self) bool {
        return self.stack.isEmpty();
    }

    pub fn clear(self: *Self) void {
        return self.stack.clear();
    }
};

/// test byte code. if included `repeat` command, will set repeat times forced to 0.
pub fn byteCodeTest(allocator: std.mem.Allocator, bytecode: []const u8) !void {
    var handler = NothingHandler{};
    var controller = try mod.Controller.init(allocator, &handler, .{});
    defer controller.deinit();

    var runner = CommandRunner(CallStackAllocTest){
        .controller = controller,
        .stack = .init(allocator),
    };
    defer runner.deinit();
    try runner.runByteCode(bytecode);
}

test "check test" {
    const bytecode = &[_]u8{ 0x01, 81, 61 };
    try byteCodeTest(std.testing.allocator, bytecode);
}
