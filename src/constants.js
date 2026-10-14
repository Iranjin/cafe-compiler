// 組み込み定数。値は Input Conditional [0E] のボタン表 (TCP Gecko 2.53 ドキュメント) から転記。

const CONTROLLERS = {
  GAMEPAD: 0,
  WIIMOTE: 1,
  NUNCHUK: 2, // WiiMote & Nunchuck
  CLASSIC: 3, // Classic / Pro Controller
  PRO: 3,
};

// ボタン名: [GamePad, WiiMote, WiiMote&Nunchuck, Classic, Pro]  (null = 該当なし)
const BUTTONS = {
  A: [0x00008000, 0x00000800, 0x00000800, 0x00000010, 0x00000010],
  B: [0x00004000, 0x00000400, 0x00000400, 0x00000040, 0x00000040],
  X: [0x00002000, null, null, 0x00000008, 0x00000008],
  Y: [0x00001000, null, null, 0x00000020, 0x00000020],
  ONE: [null, 0x00000200, 0x00000200, null, null],
  TWO: [null, 0x00000100, 0x00000100, null, null],
  LEFT: [0x00000800, 0x00000001, 0x00000001, 0x00000002, 0x00000002],
  RIGHT: [0x00000400, 0x00000002, 0x00000002, 0x00008000, 0x00008000],
  UP: [0x00000200, 0x00000008, 0x00000008, 0x00000001, 0x00000001],
  DOWN: [0x00000100, 0x00000004, 0x00000004, 0x00004000, 0x00004000],
  Z: [null, null, 0x00002000, null, null],
  C: [null, null, 0x00004000, null, null],
  ZL: [0x00000080, null, null, 0x00000080, 0x00000080],
  ZR: [0x00000040, null, null, 0x00000004, 0x00000004],
  L: [0x00000020, null, null, 0x00002000, 0x00002000],
  R: [0x00000010, null, null, 0x00000200, 0x00000200],
  PLUS: [0x00000008, 0x00000010, 0x00000010, 0x00000400, 0x00000400],
  MINUS: [0x00000004, 0x00001000, 0x00001000, 0x00001000, 0x00001000],
  HOME: [0x00000002, 0x00008000, 0x00008000, 0x00000800, 0x00000800],
  SYNC: [0x00000001, null, null, null, null],
  STICK_R: [0x00020000, null, null, null, 0x00001000],
  STICK_L: [0x00040000, null, null, null, 0x00002000],
  TV: [0x00010000, null, null, null, null],
  RSTICK_LEFT: [0x04000000, null, null, 0x00100000, 0x00400000],
  RSTICK_RIGHT: [0x02000000, null, null, 0x00200000, 0x00800000],
  RSTICK_UP: [0x01000000, null, null, 0x00800000, 0x02000000],
  RSTICK_DOWN: [0x00800000, null, null, 0x00400000, 0x01000000],
  LSTICK_LEFT: [0x40000000, null, null, 0x00010000, 0x00040000],
  LSTICK_RIGHT: [0x20000000, null, null, 0x00020000, 0x00080000],
  LSTICK_UP: [0x10000000, null, null, 0x00080000, 0x00200000],
  LSTICK_DOWN: [0x08000000, null, null, 0x00040000, 0x00100000],
  STICK_LEFT: [null, null, 0x00000001, null, null],
  STICK_RIGHT: [null, null, 0x00000002, null, null],
  STICK_UP: [null, null, 0x00000008, null, null],
  STICK_DOWN: [null, null, 0x00000004, null, null],
};

const PREFIXES = ['VPAD', 'WPAD', 'NUNCHUK', 'CLASSIC', 'PRO'];

export const BUILTIN_CONSTANTS = { ...CONTROLLERS };
for (const [name, values] of Object.entries(BUTTONS)) {
  values.forEach((v, i) => {
    if (v !== null) BUILTIN_CONSTANTS[`${PREFIXES[i]}_${name}`] = v;
  });
}
