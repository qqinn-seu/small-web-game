import { BRUSH_COLORS, FACE_GRID_SIZE } from '../../../shared/constants.js';
import type { FaceCanvas, RoomState, StoredStroke } from '../../../shared/models.js';
import type {
  AckResult,
  DrawingRequest,
  RoomEntryData,
  StrokeBeginRequest,
  StrokeEndRequest,
  StrokePointsRequest,
} from '../../../shared/protocol.js';
import { BoardRenderer } from '../canvas/board-renderer.js';
import { confirmedPixelCount, FaceRenderer } from '../canvas/face-renderer.js';
import type { GameAudioState } from '../audio/types.js';
import { DrawingController } from '../input/drawing-controller.js';
import { bindBoardInput } from '../input/board-input.js';
import type { ClientIdentity } from '../network/socket-client.js';
import { CharacterPresentation } from '../presentation/character-presentation.js';

export interface AppActions {
  establishIdentity: (nickname: string) => void;
  createRoom: () => void;
  joinRoom: (roomCode: string) => void;
  setReady: () => void;
  placeMove: (x: number, y: number) => void;
  leaveRoom: () => void;
  resolveDisconnect: (targetPlayerId: string, decision: 'claim_win' | 'keep_waiting') => void;
  strokeBegin: (request: StrokeBeginRequest) => Promise<AckResult>;
  strokePoints: (request: StrokePointsRequest) => Promise<AckResult>;
  strokeEnd: (request: StrokeEndRequest) => Promise<AckResult>;
  drawingSkip: (request: DrawingRequest) => Promise<AckResult>;
  requestDrawingSync: (reason: string) => void;
  proposeWash: () => void;
  respondWash: (proposalId: string, accept: boolean) => void;
  toggleMute: () => void;
}

interface SeatNodes {
  seatId: 'A' | 'B';
  card: HTMLElement;
  color: HTMLElement;
  name: HTMLElement;
  online: HTMLElement;
  ready: HTMLElement;
  faceCanvas: HTMLCanvasElement;
  faceRenderer: FaceRenderer;
  characterCanvas: HTMLCanvasElement;
  characterState: HTMLElement;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`缺少界面元素：${selector}`);
  return element;
}

function invitationFrom(roomCode: string, path?: string): string {
  const route = path || `/r/${encodeURIComponent(roomCode)}`;
  return new URL(route, window.location.origin).toString();
}

export class GameUI {
  private readonly nicknameInput: HTMLInputElement;
  private readonly identityPanel: HTMLElement;
  private readonly lobby: HTMLElement;
  private readonly gamePanel: HTMLElement;
  private readonly fullRoomNote: HTMLElement;
  private readonly roomCodeInput: HTMLInputElement;
  private readonly createButton: HTMLButtonElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly joinPanel: HTMLElement;
  private readonly readyButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly claimWinButton: HTMLButtonElement;
  private readonly keepWaitingButton: HTMLButtonElement;
  private readonly reconnectCountdown: HTMLElement;
  private readonly roomCode: HTMLElement;
  private readonly playerName: HTMLElement;
  private readonly version: HTMLElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly currentTurn: HTMLElement;
  private readonly statusMessage: HTMLElement;
  private readonly serverStatus: HTMLElement;
  private readonly syncMessage: HTMLElement;
  private readonly wakeNotice: HTMLElement;
  private readonly pendingMove: HTMLElement;
  private readonly moveCount: HTMLElement;
  private readonly resultMessage: HTMLElement;
  private readonly invitePanel: HTMLElement;
  private readonly inviteInput: HTMLInputElement;
  private readonly copyInviteButton: HTMLButtonElement;
  private readonly boardCanvas: HTMLCanvasElement;
  private readonly boardCaption: HTMLElement;
  private readonly seats: SeatNodes[];
  private readonly characters: CharacterPresentation;
  private readonly renderer: BoardRenderer;
  private readonly unbindBoardInput: () => void;
  private readonly drawingStage: HTMLElement;
  private readonly drawingTarget: HTMLElement;
  private readonly drawingSubtitle: HTMLElement;
  private readonly drawingCountdown: HTMLElement;
  private readonly drawingCanvas: HTMLCanvasElement;
  private readonly drawingRenderer: FaceRenderer;
  private readonly drawingController: DrawingController;
  private readonly brushButtons: HTMLButtonElement[];
  private readonly drawingSkipButton: HTMLButtonElement;
  private readonly washPanel: HTMLElement;
  private readonly washButton: HTMLButtonElement;
  private readonly washAcceptButton: HTMLButtonElement;
  private readonly washRejectButton: HTMLButtonElement;
  private readonly washStatus: HTMLElement;
  private readonly clockTimer: number;

  private room: RoomState | null = null;
  private identity: ClientIdentity | null = null;
  private networkReady = false;
  private roomEntryBusy = false;
  private readyBusy = false;
  private movePending = false;
  private roomFull = false;
  private synchronizing = false;
  private restoringRoom = false;
  private invitation: string | null = null;
  private connectionText = '正在连接服务器。';
  private messageText = '';
  private serverText = '服务器：正在连接';
  private clockOffsetMs = 0;
  private selectedBrushColor = 0;
  private localPreview: StoredStroke | null = null;
  private coldStartHintVisible = true;

  public constructor(root: HTMLElement, private readonly actions: AppActions, initialRoomCode?: string) {
    root.innerHTML = `
      <main class="app-shell">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">●</div>
            <div><h1>同桌五子棋</h1><p>两个人，一盘认真下完的棋。</p></div>
          </div>
          <div class="topbar-actions"><button class="mute-button secondary" data-testid="mute-button" type="button" aria-pressed="false" data-muted="false" data-audio-unlocked="false" data-audio-supported="false" data-played-stone="0" data-played-turn="0" data-played-win="0" data-played-lose="0" data-played-brush="0">静音</button><span class="version" data-testid="room-version">M4 v0.4.0</span></div>
        </header>

        <section class="connection-strip" aria-live="polite">
          <strong class="server-status">服务器：正在连接</strong>
          <span class="status-message" data-testid="status-message">正在连接服务器。</span>
          <span class="sync-message" hidden>正在同步房间状态…</span>
          <span class="wake-note" hidden>免费 Render 首次唤醒可能需要等几十秒，请稍候。</span>
        </section>

        <section class="identity-panel panel">
          <div class="panel-inner">
            <h2>先留下一个昵称</h2>
            <p>身份只保存在当前浏览器，用于刷新后恢复自己的座位；不需要账号。</p>
            <form class="identity-form"><div class="form-row">
              <label class="field">昵称（1–12 字符）
                <input data-testid="nickname-input" maxlength="12" autocomplete="nickname" placeholder="例如：小林" required />
              </label>
              <button type="submit">建立身份</button>
            </div></form>
          </div>
        </section>

        <section class="lobby panel" hidden>
          <div class="panel-inner">
            <div class="full-room-note" hidden>房间已满，无法查看原房间状态。请创建一个新房间。</div>
            <div class="lobby-grid">
              <div>
                <h2>开一盘新棋</h2>
                <p class="muted">创建后把邀请链接发给对方，两人准备即可开始。</p>
                <button data-testid="create-room" type="button">创建房间</button>
              </div>
              <div class="lobby-divider">
                <h2>加入好友房间</h2>
                <form class="join-form"><div class="form-row">
                  <label class="field">房间码
                    <input data-testid="room-code-input" maxlength="32" autocapitalize="characters" autocomplete="off" placeholder="输入房间码" />
                  </label>
                  <button data-testid="join-room" type="submit">加入房间</button>
                </div></form>
              </div>
            </div>
          </div>
        </section>

        <section class="game-layout" hidden>
          <aside class="side-stack">
            <section class="room-card panel">
              <div class="room-meta"><span class="room-label">房间码</span><strong class="room-code" data-testid="room-code">—</strong></div>
              <p class="player-line">你是：<strong class="own-player-name" data-testid="own-player-name">未建立身份</strong></p>
            </section>
            <section class="turn-card">
              <strong class="turn-label">等待房间状态</strong>
              <p class="reconnect-countdown" data-testid="reconnect-countdown" hidden></p>
              <p class="rules">规则：15×15，黑棋先手，无禁手，连续五子及以上获胜。</p>
            </section>
            <div class="room-actions">
              <button class="ready-button" data-testid="ready-button" type="button" hidden>准备开始</button>
              <button class="secondary leave-button" data-testid="leave-button" type="button" hidden>离开房间</button>
            </div>
            <div class="disconnect-actions" hidden>
              <button data-testid="claim-win-button" type="button" hidden>判定获胜</button>
              <button class="secondary" data-testid="keep-waiting-button" type="button" hidden>继续等待</button>
            </div>
            <section class="wash-panel panel" hidden>
              <div class="wash-heading"><strong>共同洗脸</strong><span>双方同意才会清除两张脸</span></div>
              <p data-testid="wash-status" class="wash-status"></p>
              <div class="wash-actions">
                <button data-testid="wash-button" type="button">提议洗脸</button>
                <button data-testid="wash-accept" type="button" hidden>接受洗脸</button>
                <button data-testid="wash-reject" class="secondary" type="button" hidden>拒绝</button>
              </div>
            </section>
            <section class="invite-panel panel" hidden>
              <h3>邀请对方加入</h3>
              <p>可直接复制；若浏览器不允许自动复制，请手动复制下方链接。</p>
              <div class="invite-row"><input readonly aria-label="邀请链接" /><button class="secondary" type="button">复制链接</button></div>
            </section>
          </aside>

          <section class="match-stage" aria-label="对局舞台">
          <article class="seat-card character-slot character-slot--a" data-seat="A">
            <div class="seat-top"><span class="seat-color">黑棋</span><span class="seat-online">空位</span></div>
            <canvas class="character-canvas" data-testid="character-canvas" aria-label="A座全身像素角色"></canvas>
            <canvas class="face-canvas face-canvas--source" data-testid="face-canvas" aria-label="A座玩家静态脸"></canvas>
            <div class="seat-bottom"><strong class="seat-name" data-testid="player-name">等待玩家</strong><div class="seat-ready">未准备</div><span class="character-state" aria-live="polite">待机</span></div>
          </article>
          <section class="board-panel panel">
            <canvas class="board-canvas" data-testid="board-canvas" aria-label="15乘15五子棋棋盘"></canvas>
            <div class="board-caption"><span data-testid="move-count">第 0 手 / 225</span><span class="pending-move" data-testid="pending-move" hidden>落子中</span></div>
            <section class="drawing-stage" hidden aria-live="polite">
              <div class="drawing-heading"><div><span class="drawing-eyebrow">结算画脸</span><h2 class="drawing-target">上一局输家</h2><p class="drawing-subtitle"></p></div><strong data-testid="drawing-countdown" class="drawing-countdown">剩余 0 秒</strong></div>
              <canvas class="drawing-canvas" data-testid="drawing-canvas" aria-label="32乘32像素画脸画布"></canvas>
              <div class="drawing-tools"><div class="brush-palette" aria-label="画笔颜色">${BRUSH_COLORS.map((color, index) => `<button type="button" class="brush-color" data-testid="brush-color-${index}" data-color-index="${index}" aria-label="画笔颜色 ${index + 1}" style="--brush-color:${color}"></button>`).join('')}</div><button data-testid="drawing-skip" class="secondary drawing-skip" type="button">跳过画脸</button></div>
              <p class="drawing-hint">按下后保持一笔连续绘制，松开才会提交；对方会实时看到服务器确认的笔迹。</p>
            </section>
            <p class="result-message" data-testid="result-message" hidden></p>
          </section>
          <article class="seat-card character-slot character-slot--b" data-seat="B">
            <div class="seat-top"><span class="seat-color">白棋</span><span class="seat-online">空位</span></div>
            <canvas class="character-canvas" data-testid="character-canvas" aria-label="B座全身像素角色"></canvas>
            <canvas class="face-canvas face-canvas--source" data-testid="face-canvas" aria-label="B座玩家静态脸"></canvas>
            <div class="seat-bottom"><strong class="seat-name" data-testid="player-name">等待玩家</strong><div class="seat-ready">未准备</div><span class="character-state" aria-live="polite">待机</span></div>
          </article>
          </section>
        </section>
      </main>`;

    this.nicknameInput = required(root, '[data-testid="nickname-input"]');
    this.identityPanel = required(root, '.identity-panel');
    this.lobby = required(root, '.lobby');
    this.gamePanel = required(root, '.game-layout');
    this.fullRoomNote = required(root, '.full-room-note');
    this.roomCodeInput = required(root, '[data-testid="room-code-input"]');
    this.createButton = required(root, '[data-testid="create-room"]');
    this.joinButton = required(root, '[data-testid="join-room"]');
    this.joinPanel = required(root, '.lobby-divider');
    this.readyButton = required(root, '[data-testid="ready-button"]');
    this.leaveButton = required(root, '[data-testid="leave-button"]');
    this.claimWinButton = required(root, '[data-testid="claim-win-button"]');
    this.keepWaitingButton = required(root, '[data-testid="keep-waiting-button"]');
    this.reconnectCountdown = required(root, '[data-testid="reconnect-countdown"]');
    this.roomCode = required(root, '[data-testid="room-code"]');
    this.playerName = required(root, '[data-testid="own-player-name"]');
    this.version = required(root, '[data-testid="room-version"]');
    this.muteButton = required(root, '[data-testid="mute-button"]');
    this.currentTurn = required(root, '.turn-label');
    this.statusMessage = required(root, '[data-testid="status-message"]');
    this.serverStatus = required(root, '.server-status');
    this.syncMessage = required(root, '.sync-message');
    this.wakeNotice = required(root, '.wake-note');
    this.pendingMove = required(root, '[data-testid="pending-move"]');
    this.moveCount = required(root, '[data-testid="move-count"]');
    this.resultMessage = required(root, '[data-testid="result-message"]');
    this.invitePanel = required(root, '.invite-panel');
    this.inviteInput = required(root, '.invite-row input');
    this.copyInviteButton = required(root, '.invite-row button');
    this.boardCanvas = required(root, '[data-testid="board-canvas"]');
    this.boardCaption = required(root, '.board-caption');
    this.drawingStage = required(root, '.drawing-stage');
    this.drawingTarget = required(root, '.drawing-target');
    this.drawingSubtitle = required(root, '.drawing-subtitle');
    this.drawingCountdown = required(root, '[data-testid="drawing-countdown"]');
    this.drawingCanvas = required(root, '[data-testid="drawing-canvas"]');
    this.drawingSkipButton = required(root, '[data-testid="drawing-skip"]');
    this.brushButtons = BRUSH_COLORS.map((_, index) => required<HTMLButtonElement>(root, `[data-testid="brush-color-${index}"]`));
    this.washPanel = required(root, '.wash-panel');
    this.washButton = required(root, '[data-testid="wash-button"]');
    this.washAcceptButton = required(root, '[data-testid="wash-accept"]');
    this.washRejectButton = required(root, '[data-testid="wash-reject"]');
    this.washStatus = required(root, '[data-testid="wash-status"]');
    this.seats = (['A', 'B'] as const).map((seatId) => {
      const card = required<HTMLElement>(root, `[data-seat="${seatId}"]`);
      const faceCanvas = required<HTMLCanvasElement>(card, '[data-testid="face-canvas"]');
      return {
        seatId,
        card,
        color: required(card, '.seat-color'),
        name: required(card, '.seat-name'),
        online: required(card, '.seat-online'),
        ready: required(card, '.seat-ready'),
        faceCanvas,
        faceRenderer: new FaceRenderer(faceCanvas),
        characterCanvas: required<HTMLCanvasElement>(card, '[data-testid="character-canvas"]'),
        characterState: required(card, '.character-state'),
      };
    });

    this.characters = new CharacterPresentation(this.seats.map((seat) => ({
      seatId: seat.seatId,
      canvas: seat.characterCanvas,
      card: seat.card,
      label: seat.characterState,
      bodyAsset: seat.seatId === 'A' ? '/assets/sprites/body-a.png' : '/assets/sprites/body-b.png',
    })));

    this.renderer = new BoardRenderer(this.boardCanvas);
    this.drawingRenderer = new FaceRenderer(this.drawingCanvas);
    this.drawingController = new DrawingController({
      canvas: this.drawingCanvas,
      getRoom: () => this.room,
      getIdentity: () => this.identity,
      isOperational: () => this.isDrawingOperational(),
      getColorIndex: () => this.selectedBrushColor,
      sender: {
        strokeBegin: (request) => this.actions.strokeBegin(request),
        strokePoints: (request) => this.actions.strokePoints(request),
        strokeEnd: (request) => this.actions.strokeEnd(request),
        drawingSkip: (request) => this.actions.drawingSkip(request),
      },
      requestSync: (reason) => this.actions.requestDrawingSync(reason),
      notify: (message) => this.notify(message),
      onLocalPreview: (preview) => {
        this.localPreview = preview;
        this.characters.setLocalPreview(preview);
        this.renderFaces();
        this.renderDrawing();
      },
    });
    this.unbindBoardInput = bindBoardInput(this.boardCanvas, {
      canPlace: () => this.canPlace(),
      onPlaceIntent: (x, y) => this.actions.placeMove(x, y),
    });

    required<HTMLFormElement>(root, '.identity-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.actions.establishIdentity(this.nicknameInput.value);
    });
    this.createButton.addEventListener('click', () => this.actions.createRoom());
    required<HTMLFormElement>(root, '.join-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.actions.joinRoom(this.roomCodeInput.value.trim().toUpperCase());
    });
    this.readyButton.addEventListener('click', () => this.actions.setReady());
    this.leaveButton.addEventListener('click', () => this.actions.leaveRoom());
    this.claimWinButton.addEventListener('click', () => this.resolveOpponent('claim_win'));
    this.keepWaitingButton.addEventListener('click', () => this.resolveOpponent('keep_waiting'));
    this.copyInviteButton.addEventListener('click', () => void this.copyInvitation());
    this.muteButton.addEventListener('click', () => this.actions.toggleMute());
    this.brushButtons.forEach((button, index) => button.addEventListener('click', () => {
      this.selectedBrushColor = index;
      this.renderDrawing();
    }));
    this.drawingSkipButton.addEventListener('click', () => this.drawingController.skip());
    this.washButton.addEventListener('click', () => this.actions.proposeWash());
    this.washAcceptButton.addEventListener('click', () => this.respondWash(true));
    this.washRejectButton.addEventListener('click', () => this.respondWash(false));

    if (initialRoomCode) {
      this.roomCodeInput.value = initialRoomCode;
      this.messageText = '已从邀请链接填入房间码；请先建立昵称身份再加入。';
    }
    this.clockTimer = window.setInterval(() => this.render(), 1_000);
    this.render();
  }

  public setIdentity(identity: ClientIdentity | null, ready: boolean): void {
    this.identity = identity;
    this.networkReady = ready;
    if (ready) this.coldStartHintVisible = false;
    if (identity) this.nicknameInput.value = identity.nickname;
    this.render();
    this.drawingController.setOperational();
    this.syncCharacterActivity();
  }

  /** Display a saved nickname while its private credential is being verified. */
  public setRestoringIdentity(nickname: string): void {
    this.nicknameInput.value = nickname;
    this.connectionText = '正在恢复本浏览器保存的身份…';
    this.render();
  }

  public getNickname(): string {
    return this.nicknameInput.value.trim();
  }

  public setNetworkReady(ready: boolean): void {
    this.networkReady = ready;
    if (ready) this.coldStartHintVisible = false;
    this.render();
    this.drawingController.setOperational();
    this.syncCharacterActivity();
  }

  public setClockOffset(serverTime: number): void {
    if (Number.isFinite(serverTime)) this.clockOffsetMs = serverTime - Date.now();
    this.render();
  }

  public setRoom(room: RoomState | null): void {
    const enteringPlaying = room?.phase === 'playing' && this.room?.phase !== 'playing';
    this.room = room;
    if (room?.phase === 'playing') this.messageText = '';
    this.renderer.setRoom(room);
    this.characters.setRoom(room);
    this.drawingController.setRoom(room);
    this.render();
    this.syncCharacterActivity();
    if (enteringPlaying) {
      window.requestAnimationFrame(() => {
        this.boardCanvas.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      });
    }
  }

  public setRoomEntryBusy(busy: boolean): void {
    this.roomEntryBusy = busy;
    this.render();
  }

  public setReadyBusy(busy: boolean): void {
    this.readyBusy = busy;
    this.render();
  }

  public setMovePending(pending: boolean): void {
    this.movePending = pending;
    this.render();
  }

  public setRoomFull(full: boolean): void {
    this.roomFull = full;
    this.render();
  }

  public setSynchronizing(synchronizing: boolean): void {
    this.synchronizing = synchronizing;
    this.render();
    this.drawingController.setOperational();
    this.syncCharacterActivity();
  }

  public setRestoringRoom(restoring: boolean): void {
    this.restoringRoom = restoring;
    this.render();
    this.drawingController.setOperational();
    this.syncCharacterActivity();
  }

  /** Called only by the accepted contiguous live-patch path in main.ts. */
  public onLivePatch(before: RoomState, next: RoomState): void {
    this.characters.onLivePatch(before, next);
  }

  /** Presentation-only reflection of the parent-owned Web Audio lifecycle. */
  public setAudioState(state: GameAudioState): void {
    this.muteButton.textContent = state.muted ? '音效' : '静音';
    this.muteButton.setAttribute('aria-pressed', String(state.muted));
    this.muteButton.dataset.muted = String(state.muted);
    this.muteButton.dataset.audioUnlocked = String(state.unlocked);
    this.muteButton.dataset.audioSupported = String(state.supported);
    this.muteButton.dataset.playedStone = String(state.played.stone);
    this.muteButton.dataset.playedTurn = String(state.played.turn);
    this.muteButton.dataset.playedWin = String(state.played.win);
    this.muteButton.dataset.playedLose = String(state.played.lose);
    this.muteButton.dataset.playedBrush = String(state.played.brush);
  }

  public setInvitation(entry: RoomEntryData | null): void {
    this.invitation = entry ? invitationFrom(entry.roomCode, entry.invitationPath) : null;
    this.render();
  }

  public setConnection(message: string): void {
    this.connectionText = message;
    this.render();
  }

  public setServerStatus(message: string): void {
    this.serverText = message;
    this.render();
  }

  public notify(message: string): void {
    this.messageText = message;
    this.render();
  }

  public clearNotice(): void {
    this.messageText = '';
    this.render();
  }

  public destroy(): void {
    window.clearInterval(this.clockTimer);
    this.unbindBoardInput();
    this.renderer.destroy();
    this.drawingController.destroy();
    this.drawingRenderer.destroy();
    this.seats.forEach((seat) => seat.faceRenderer.destroy());
    this.characters.destroy();
  }

  private render(): void {
    const ownSeat = this.room?.seats.find((seat) => seat?.playerId === this.identity?.playerId) ?? null;
    const roomCode = this.room?.roomCode ?? '';
    const invite = this.invitation ?? (roomCode ? invitationFrom(roomCode) : '');
    const drawingActive = this.room?.phase === 'drawing';

    this.identityPanel.hidden = Boolean(this.identity);
    this.lobby.hidden = Boolean(this.room) || this.restoringRoom;
    this.gamePanel.hidden = !this.room;
    this.fullRoomNote.hidden = !this.roomFull || Boolean(this.room);
    this.joinPanel.hidden = this.roomFull && !this.room;
    const admissionBlocked = Boolean(this.identity) && !this.networkReady;
    this.createButton.disabled = this.roomEntryBusy || Boolean(this.room) || admissionBlocked;
    this.joinButton.disabled = this.roomEntryBusy || Boolean(this.room) || admissionBlocked;
    this.roomCodeInput.disabled = this.roomEntryBusy || Boolean(this.room) || admissionBlocked;
    this.createButton.textContent = this.roomFull && !this.room ? '创建新房间' : '创建房间';
    this.nicknameInput.disabled = Boolean(this.identity);

    this.roomCode.textContent = roomCode || '—';
    this.playerName.textContent = this.identity?.nickname ?? '未建立身份';
    this.version.textContent = this.room ? `M4 v0.4.0 · 状态 v${this.room.version}` : 'M4 v0.4.0';
    this.serverStatus.textContent = this.serverText;
    this.statusMessage.textContent = this.connectionPriorityText() || this.messageText || (this.room ? this.turnText() : this.connectionText);
    this.syncMessage.hidden = !this.synchronizing || this.restoringRoom;
    this.wakeNotice.hidden = !this.coldStartHintVisible || this.networkReady || !this.connectionText.startsWith('正在连接服务器');
    this.pendingMove.hidden = !this.movePending;
    this.moveCount.textContent = `第 ${this.room?.round?.moveNo ?? 0} 手 / 225`;
    this.boardCanvas.hidden = Boolean(drawingActive);
    this.boardCaption.hidden = Boolean(drawingActive);
    this.drawingStage.hidden = !drawingActive;

    this.renderSeats();
    this.renderFaces();
    this.currentTurn.textContent = this.turnText();
    this.renderReady(ownSeat);
    this.renderLeave(ownSeat);
    this.renderDisconnectDecision(ownSeat);
    this.renderDrawing();
    this.renderWash(ownSeat);
    this.invitePanel.hidden = !this.room;
    this.inviteInput.value = invite;
    this.renderResult();
  }

  private renderSeats(): void {
    const round = this.room?.round ?? null;
    this.seats.forEach((nodes, index) => {
      const seat = this.room?.seats[index] ?? null;
      const fallbackColor = index === 0 ? '黑棋' : '白棋';
      let color = fallbackColor;
      if (seat && round) {
        color = !round.participantIds.includes(seat.playerId)
          ? '等待新局'
          : seat.playerId === round.blackPlayerId
            ? '黑棋'
            : '白棋';
      }
      nodes.color.textContent = color;
      nodes.name.textContent = seat?.nickname || '等待玩家';
      nodes.online.textContent = seat ? (seat.connected ? '在线' : '离线') : '空位';
      nodes.online.classList.toggle('offline', Boolean(seat && !seat.connected));
      nodes.ready.textContent = seat ? (seat.ready ? '已准备' : '未准备') : '等待加入';
      nodes.card.classList.toggle('seat-card--self', seat?.playerId === this.identity?.playerId);
      if (seat) nodes.card.dataset.playerId = seat.playerId;
      else delete nodes.card.dataset.playerId;
    });
  }

  private renderFaces(): void {
    const drawing = this.room?.phase === 'drawing' ? this.room.drawing : null;
    this.seats.forEach((seatNodes, index) => {
      const seat = this.room?.seats[index] ?? null;
      const ownerPlayerId = seat?.playerId ?? '';
      const face = ownerPlayerId ? this.faceFor(ownerPlayerId) : null;
      const isTarget = Boolean(drawing && ownerPlayerId === drawing.targetPlayerId);
      seatNodes.faceRenderer.setState({
        face,
        draft: isTarget ? drawing?.draft : null,
        localPreview: isTarget ? this.localPreview : null,
      });
      // The target can have left its seat during drawing; static seat cards still
      // retain their own owner metadata rather than being re-bound to a newcomer.
      seatNodes.faceCanvas.dataset.playerId = ownerPlayerId;
      seatNodes.faceCanvas.dataset.ownerPlayerId = ownerPlayerId;
      seatNodes.faceCanvas.dataset.revision = String(face?.revision ?? 0);
      seatNodes.faceCanvas.dataset.confirmedPixelCount = String(confirmedPixelCount(face));
    });

    const targetPlayerId = drawing?.targetPlayerId ?? '';
    const targetFace = targetPlayerId ? this.faceFor(targetPlayerId) : null;
    this.drawingRenderer.setState({
      face: targetFace,
      draft: drawing?.draft ?? null,
      localPreview: this.localPreview,
    });
    this.drawingCanvas.dataset.playerId = targetPlayerId;
    this.drawingCanvas.dataset.ownerPlayerId = targetPlayerId;
    this.drawingCanvas.dataset.revision = String(targetFace?.revision ?? 0);
    this.drawingCanvas.dataset.confirmedPixelCount = String(confirmedPixelCount(targetFace));
  }

  private renderDrawing(): void {
    const drawing = this.room?.phase === 'drawing' ? this.room.drawing : null;
    const targetFace = drawing ? this.faceFor(drawing.targetPlayerId) : null;
    const isWinner = Boolean(drawing && drawing.winnerPlayerId === this.identity?.playerId);
    const canDraw = this.drawingController.canStart();
    const canSkip = this.drawingController.canSkip();
    const targetName = drawing?.targetNickname ?? this.nicknameFor(drawing?.targetPlayerId) ?? '上一局输家';

    this.drawingTarget.textContent = targetName;
    this.drawingSubtitle.textContent = isWinner
      ? `你获胜了，选择颜色后在 ${targetName} 的脸上画一笔。`
      : drawing
        ? `${drawing.winnerNickname ?? this.nicknameFor(drawing.winnerPlayerId) ?? '获胜者'} 正在结算这一局。`
        : '';
    this.drawingCountdown.textContent = drawing ? `剩余 ${this.secondsRemaining(drawing.deadlineAt)} 秒` : '剩余 0 秒';
    this.drawingCanvas.dataset.ownerPlayerId = drawing?.targetPlayerId ?? '';
    this.drawingCanvas.dataset.drawingId = drawing?.drawingId ?? '';
    this.drawingCanvas.dataset.phase = this.room?.phase ?? '';
    this.drawingCanvas.dataset.draftPointCount = String(drawing?.draft?.points.length ?? 0);
    this.drawingCanvas.dataset.confirmedPixelCount = String(confirmedPixelCount(targetFace));
    this.drawingCanvas.dataset.gridSize = String(FACE_GRID_SIZE);
    this.drawingCanvas.dataset.canDraw = String(canDraw);

    this.brushButtons.forEach((button, index) => {
      button.hidden = !isWinner;
      button.disabled = !canDraw;
      button.classList.toggle('brush-color--selected', index === this.selectedBrushColor);
      button.setAttribute('aria-pressed', String(index === this.selectedBrushColor));
    });
    this.drawingSkipButton.hidden = !isWinner;
    this.drawingSkipButton.disabled = !canSkip;
  }

  private renderWash(ownSeat: RoomState['seats'][number] | null): void {
    const phaseAllowsWash = this.room?.phase === 'waiting' || this.room?.phase === 'finished';
    const everyoneOnline = Boolean(this.room?.seats.every((seat) => seat?.connected));
    const proposal = phaseAllowsWash ? this.room?.washProposal ?? null : null;
    const canUseWash = Boolean(ownSeat && phaseAllowsWash && everyoneOnline && this.networkReady && !this.synchronizing && !this.restoringRoom);
    this.washPanel.hidden = !canUseWash && !proposal;
    this.washButton.hidden = Boolean(proposal);
    this.washButton.disabled = !canUseWash;
    this.washAcceptButton.hidden = true;
    this.washRejectButton.hidden = true;

    if (!proposal) {
      this.washStatus.textContent = canUseWash ? '两人在线，可提议清空双方累计笔迹。' : '';
      return;
    }
    const isProposer = proposal.proposerPlayerId === this.identity?.playerId;
    const canRespond = canUseWash && !isProposer && proposal.participantIds.includes(this.identity?.playerId ?? '');
    this.washAcceptButton.hidden = !canRespond;
    this.washRejectButton.hidden = !canRespond;
    this.washAcceptButton.disabled = !canRespond;
    this.washRejectButton.disabled = !canRespond;
    this.washStatus.textContent = isProposer
      ? `已提议洗脸，等待对方确认（${this.secondsRemaining(proposal.deadlineAt)} 秒）。`
      : `对方提议清空双方笔迹（${this.secondsRemaining(proposal.deadlineAt)} 秒）。`;
  }

  private turnText(): string {
    if (!this.room) return this.restoringRoom ? '正在恢复原房间座位' : '等待房间状态';
    const drawing = this.room.phase === 'drawing' ? this.room.drawing : null;
    if (drawing) {
      if (drawing.winnerPlayerId === this.identity?.playerId) return `你赢了，请给 ${drawing.targetNickname ?? '对方'} 画脸`;
      if (drawing.targetPlayerId === this.identity?.playerId) return '本局失利，对方正在给你的脸作画';
      return '前一局正在结算，等待前任玩家完成画脸';
    }
    const round = this.room.round;
    if (!round) return '等待两位玩家准备开始';
    const ownIsParticipant = Boolean(this.identity && round.participantIds.includes(this.identity.playerId));
    if (round.result || this.room.phase === 'finished') {
      return ownIsParticipant ? '本局已经结束，可以准备再来一局' : '上一局已经结束，等待新局';
    }
    if (round.paused) {
      const opponentId = ownIsParticipant
        ? round.participantIds.find((playerId) => playerId !== this.identity?.playerId)
        : undefined;
      const opponent = this.room.seats.find((seat) => seat?.playerId === opponentId) ?? null;
      return opponent && !opponent.connected ? '对方掉线，等待重连' : '对局已暂停，等待服务器状态更新';
    }
    if (this.room.phase !== 'playing' || !round.turnPlayerId) return '等待对局开始';
    const seat = this.room.seats.find((item) => item?.playerId === round.turnPlayerId) ?? null;
    const side = round.turnPlayerId === round.blackPlayerId ? '黑棋' : '白棋';
    return round.turnPlayerId === this.identity?.playerId
      ? `轮到你落子（${side}）`
      : `轮到 ${seat?.nickname || '对方'} 落子（${side}）`;
  }

  private renderReady(ownSeat: RoomState['seats'][number] | null): void {
    const phase = this.room?.phase;
    const show = Boolean(ownSeat && (phase === 'waiting' || phase === 'finished'));
    this.readyButton.hidden = !show;
    if (!show) return;
    this.readyButton.textContent = ownSeat?.ready
      ? '取消准备'
      : phase === 'finished'
        ? '再来一局'
        : '准备开始';
    this.readyButton.disabled = !this.networkReady || this.readyBusy || this.synchronizing || this.restoringRoom;
  }

  private renderLeave(ownSeat: RoomState['seats'][number] | null): void {
    const show = Boolean(ownSeat);
    this.leaveButton.hidden = !show;
    if (!show) return;
    this.leaveButton.textContent = this.room?.phase === 'playing' ? '离开并认输' : '离开房间';
    this.leaveButton.disabled = !this.networkReady || this.synchronizing || this.restoringRoom;
  }

  private renderDisconnectDecision(ownSeat: RoomState['seats'][number] | null): void {
    const round = this.room?.round;
    const ownIsParticipant = Boolean(round && this.identity && round.participantIds.includes(this.identity.playerId));
    const opponentId = ownIsParticipant
      ? round?.participantIds.find((playerId) => playerId !== this.identity?.playerId)
      : undefined;
    const opponent = this.room?.seats.find((seat) => seat?.playerId === opponentId) ?? null;
    const waitingForOpponent = Boolean(
      round
      && this.room?.phase === 'playing'
      && round.paused
      && ownSeat?.connected
      && opponent
      && !opponent.connected,
    );
    this.reconnectCountdown.hidden = !waitingForOpponent;
    if (waitingForOpponent) {
      const deadline = opponent?.reconnectDeadline;
      const seconds = typeof deadline === 'number' ? this.secondsRemaining(deadline) : null;
      this.reconnectCountdown.textContent = seconds === null
        ? '对方掉线，等待重连。'
        : seconds > 0
          ? `对方掉线，等待重连（${seconds} 秒）。`
          : '对方掉线已超过宽限期，可以判定获胜或继续等待。';
    } else {
      this.reconnectCountdown.textContent = '';
    }

    const graceElapsed = opponent?.reconnectDeadline !== null && opponent?.reconnectDeadline !== undefined
      && Date.now() + this.clockOffsetMs >= opponent.reconnectDeadline;
    const canDecide = Boolean(waitingForOpponent && opponent?.disconnectDecisionAvailable && graceElapsed);
    const actions = this.claimWinButton.parentElement;
    if (actions) actions.hidden = !canDecide;
    this.claimWinButton.hidden = !canDecide;
    this.keepWaitingButton.hidden = !canDecide;
    const disabled = !this.networkReady || this.synchronizing || this.restoringRoom;
    this.claimWinButton.disabled = disabled;
    this.keepWaitingButton.disabled = disabled;
  }

  private renderResult(): void {
    const result = this.room?.round?.result;
    const phase = this.room?.phase;
    if (!result || (phase !== 'drawing' && phase !== 'finished')) {
      this.resultMessage.hidden = true;
      this.resultMessage.textContent = '';
      return;
    }
    const isParticipant = Boolean(this.identity && this.room?.round?.participantIds.includes(this.identity.playerId));
    let outcome: string;
    if (!isParticipant) {
      outcome = phase === 'drawing'
        ? '上一局已有胜负，正在等待前任玩家完成结算；你不是本局输家。'
        : '上一局已结束；你是新加入的玩家，等待新局。';
    } else if (!result.winnerPlayerId || result.reason === 'draw') {
      outcome = '平：本局平局。';
    } else if (result.winnerPlayerId === this.identity?.playerId) {
      outcome = phase === 'drawing' ? '胜：你赢了本局，现在可以画对方的脸。' : '胜：你赢了本局。';
    } else {
      outcome = phase === 'drawing' ? '负：你失利了，对方正在给你的脸作画。' : '负：本局失利。';
    }
    this.resultMessage.textContent = outcome;
    this.resultMessage.hidden = false;
  }

  private canPlace(): boolean {
    const round = this.room?.round;
    return Boolean(
      this.networkReady
      && !this.synchronizing
      && !this.restoringRoom
      && !this.movePending
      && this.room?.phase === 'playing'
      && round
      && !round.paused
      && !round.result
      && round.turnPlayerId === this.identity?.playerId,
    );
  }

  private isDrawingOperational(): boolean {
    return this.networkReady && !this.synchronizing && !this.restoringRoom;
  }

  private syncCharacterActivity(): void {
    this.characters.setActive(this.isDrawingOperational());
  }

  private connectionPriorityText(): string | null {
    if (this.restoringRoom) return '正在恢复原房间座位，暂不可操作。';
    if (this.synchronizing) return '正在同步房间状态，暂不可操作。';
    if (this.networkReady) return null;
    if (this.connectionText === '当前页面已停止操作。') return '此页面已被另一个标签页接管，当前页面已停止操作。';
    return this.connectionText || '正在连接服务器。';
  }

  private resolveOpponent(decision: 'claim_win' | 'keep_waiting'): void {
    const round = this.room?.round;
    const playerId = round?.participantIds.find((candidate) => candidate !== this.identity?.playerId);
    if (playerId) this.actions.resolveDisconnect(playerId, decision);
  }

  private respondWash(accept: boolean): void {
    const proposal = this.room?.washProposal;
    if (proposal) this.actions.respondWash(proposal.proposalId, accept);
  }

  private faceFor(playerId: string): FaceCanvas | null {
    return this.room?.faces[playerId] ?? null;
  }

  private nicknameFor(playerId: string | undefined): string | undefined {
    if (!playerId) return undefined;
    return this.room?.seats.find((seat) => seat?.playerId === playerId)?.nickname;
  }

  private secondsRemaining(deadlineAt: number): number {
    return Math.max(0, Math.ceil((deadlineAt - (Date.now() + this.clockOffsetMs)) / 1_000));
  }

  private async copyInvitation(): Promise<void> {
    if (!this.inviteInput.value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(this.inviteInput.value);
      this.notify('邀请链接已复制。');
    } catch {
      this.inviteInput.focus();
      this.inviteInput.select();
      this.notify('浏览器未允许自动复制，请手动复制已选中的邀请链接。');
    }
  }
}
