import type { ErrorCode } from '../../../shared/protocol.js';

const ERROR_TEXT: Record<ErrorCode, string> = {
  AUTH_REQUIRED: '请先填写昵称并建立身份。',
  AUTH_INVALID: '身份凭据无效。M1 不支持刷新后恢复，请重新建立昵称身份。',
  IDENTITY_EXPIRED: '身份已失效，请重新建立昵称身份。',
  SESSION_REPLACED: '此页面已被另一个标签页接管，当前页面已停止操作。',
  INVALID_PAYLOAD: '请求格式不正确，请重试。',
  PROTOCOL_MISMATCH: '客户端版本与服务器不兼容，请刷新页面。',
  ACTION_ID_REUSED: '此操作标识已被占用，请重新操作。',
  ROOM_NOT_FOUND: '未找到该房间，请确认房间码。',
  ROOM_FULL: '房间已满，无法查看原房间状态。请创建新房间。',
  ROOM_EXPIRED: '房间已失效，请创建新房间。',
  ALREADY_IN_ROOM: '你已在一个房间中。',
  NOT_IN_ROOM: '你当前不在该房间中。',
  SEAT_RELEASED: '原座位已失效，请创建或加入新房间。',
  STALE_ROUND: '本局已经更新，请等待最新状态。',
  STALE_MOVE: '棋盘已更新，请等待最新状态后再落子。',
  INVALID_PHASE: '当前阶段不能执行此操作。',
  GAME_PAUSED: '对局已暂停，请等待服务器状态更新。',
  NOT_YOUR_TURN: '还没轮到你落子。',
  CELL_OCCUPIED: '这个位置已经有棋子。',
  DRAWING_EXPIRED: '画脸功能将在后续里程碑开放。',
  INVALID_STROKE_SEQ: '画脸功能将在后续里程碑开放。',
  RATE_LIMITED: '操作过于频繁，请稍后再试。',
  INTERNAL_ERROR: '服务器暂时出错，请稍后重试。',
};

export function messageForError(code: ErrorCode, fallback?: string): string {
  return ERROR_TEXT[code] || fallback || '操作未完成，请稍后重试。';
}
