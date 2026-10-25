# 双人像素五子棋技术方案

- 确认日期：2026-10-25
- 状态：已确认，按 M1–M5 逐步开发
- 代码仓库：https://github.com/qqinn-seu/small-web-game
- 本文件为开发与验收依据；里程碑进度记录在 TODO.md。

## 产品概述

两名玩家通过邀请链接或房间码进入同一房间，棋盘两侧各有一个代表玩家的像素小人。规则是 15×15 棋盘、黑棋先手、无禁手、连续五子及以上获胜，页面用一句话说明规则。

核心循环为“下棋 → 分出胜负 → 画脸 → 再来一局”。输家小人的脸放大显示，赢家在脸部区域画一条连续笔画，按下开始、松开结束；输家实时看到轨迹。笔画吸附到 32×32 像素网格，固定粗细，六种颜色，限时 20 秒，可跳过；平局不进入画脸。已确认笔迹在同一房间跨局累积，洗脸需双方同意。

小人状态包括待机、思考、看棋盘、欢呼、不服和被画时的表情。音效包括落子、轮到你、胜利、失败和画笔，提供静音并处理浏览器自动播放限制。

第一版不做账号系统、悔棋、聊天、排行榜、陌生人匹配、观战或永久保存作品。房间只保存在服务端内存中，不用数据库。

## 1. 技术选型及理由

### 前端

Vite + TypeScript + 原生 HTML/CSS + Canvas 2D，不引入完整游戏引擎。棋盘、小人、画脸由 Canvas 绘制；表单、房间 UI、按钮和弹窗由 HTML/CSS 实现。

分为权威状态镜像、渲染层、交互层。状态镜像只接收服务端快照和增量；渲染层按状态绘图；交互层把鼠标和触摸转换成意图，客户端不自行确定最终胜负。

棋盘和放大脸部使用独立 Canvas。小人使用像素精灵帧，涂鸦作为覆盖层叠加，动画不清除笔迹。桌面为棋盘居中、两侧小人；手机为小人在上、棋盘在下，画脸使用放大面板。Pointer Events 统一鼠标与触摸，画脸区域 touch-action: none，不禁用整页滚动。

Canvas 按设备像素比设置实际分辨率，像素精灵关闭平滑缩放。协议只传逻辑棋盘和网格坐标，不传屏幕像素。

### 后端与通信

Node.js 24 LTS + TypeScript + Express + Socket.IO 4.x，具体补丁和依赖通过锁文件固定。Express 提供静态页面、健康检查与 SPA 回退；Socket.IO 挂载到同一个 HTTP Server、同一个端口。

复用 Socket.IO 心跳、自动重连和 ACK，但不将它当作业务可靠性保证。默认投递不保证断线期间必达，仍需 actionId、业务确认和快照恢复。每次重连重新验证身份、获取完整快照，不依赖内置连接恢复作为正确性基础。[1]

### 音效与测试

Web Audio API 播放短资源或合成音，仅首次用户点击/触摸后启用 AudioContext。静音本地保存，快照恢复不补播历史音效。

Vitest 做规则、状态机、校验和幂等测试；Socket.IO Client 集成测试模拟多人、重复消息和恢复；Playwright 加手工浏览器验证页面、触摸、完整流程与弱网。

## 2. 项目目录结构

```text
small-web-game/
├── client/
│   ├── index.html
│   ├── public/assets/
│   │   ├── sprites/
│   │   └── audio/
│   └── src/
│       ├── main.ts
│       ├── network/
│       ├── state/
│       ├── canvas/
│       ├── input/
│       ├── ui/
│       ├── audio/
│       └── styles/
├── server/src/
│   ├── index.ts
│   ├── http/
│   ├── socket/
│   ├── services/
│   ├── domain/
│   ├── stores/
│   └── lifecycle/
├── shared/
│   ├── protocol.ts
│   ├── models.ts
│   └── constants.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── .github/workflows/ci.yml
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig*.json
├── vite.config.ts
├── render.yaml
└── README.md
```

shared 仅放公开类型、消息和常量。密钥、身份校验、权限、存储和最终判定不进入浏览器包。

## 3. 数据结构与房间状态机

### 身份、座位、本局与画布

玩家身份不等于座位，当前座位玩家不一定是上一局输家，必须分开。

PlayerIdentity：playerId（随机公开标识）、secretHash（不存或广播明文）、nickname（1–12 字符）、activeSocketId、controlEpoch、当前 roomInstanceId、createdAt、lastSeenAt。服务端签发高强度随机 secret，仅本人私有响应接收。客户端 localStorage 保存 playerId + secret，服务端不信任自报身份。

Seat：seatId=A/B、playerId、connected、disconnectedAt、reconnectDeadline、ready、disconnectDecisionAvailable。空座与离线保留座位不同。

Round：roundId、冻结的 participantIds、blackPlayerId、whitePlayerId、225 格 board（0空/1黑/2白）、moveNo、turnPlayerId、lastMove、paused、result。result 固定胜者、输家、原因、获胜连线和结束时间。

FaceCanvas：ownerPlayerId、revision、32×32 累计像素覆盖层、已确认笔画。按 playerId 归属，不按座位归属。新人脸干净，原身份重新加入尚存的同一房间可恢复本人笔迹。旧轨迹可压平为像素底图，不改变视觉，不无限保存原始轨迹。

Room：roomCode、不可复用的随机 roomInstanceId、单调 version、phase、两个 seats、round、faces、drawing、washProposal、noConnectedPlayersSince、createdAt、updatedAt。

drawing：drawingId、roundId、winnerPlayerId、targetPlayerId、deadlineAt（服务端+20秒）、临时笔画、已接受批次 seq、画笔机会是否使用。内部定时器、secret、幂等缓存不公开。

### waiting

允许创建/加入空座、准备/取消、离开、身份恢复、发起/回应洗脸。两人均在线且准备后进入 playing。首局 A 黑、B 白。

### playing

允许当前玩家落子、主动离开认输、身份恢复、超时裁决。掉线保持 playing + paused，禁止双方落子。禁止洗脸、画脸、再战准备。

落子形成五连及以上进入 drawing；满盘无胜者直接 finished。主动离开和超时判负也形成正式胜负并进入 drawing。

### drawing

仅冻结的胜者可开始、发送、结束一笔或跳过。允许恢复、离开、新人入空座；禁止落子、洗脸、开始新局。笔画确认、跳过或20秒截止进入 finished。

### finished

允许准备下一局、取消、洗脸、离开和入空座。双方在线并准备后进入 playing。原两人再战交换黑白；换人视为新组合，A 黑 B 白。成员更换清空准备与洗脸提议。

## 4. 完整消息协议

### 通用字段与确认

C→S 为客户端到服务端，S→C 为反向。每个业务请求带客户端 UUID actionId。认证后身份从 Socket 读取，不由请求自报。

已入房请求带 roomInstanceId、baseVersion；本局操作加 roundId，绘画加 drawingId。baseVersion用于检测落后，不对所有请求机械地要求完全相等。落子用 expectedMoveNo、绘画用 seq、洗脸用 proposalId 作为业务前置条件，避免上下线版本变化误拒合法动作。

ACK：actionId、ok；成功可含 data、appliedVersion；失败含 errorCode、message、retryable，已授权房间请求可带 needsSnapshot。ACK结束等待但不推进客户端房间 version，状态只由 snapshot/patch 更新。

### C→S 消息

1. **session:open**：actionId、protocolVersion、tabId，以及首次 nickname 或恢复 playerId+secret。校验协议、昵称、密钥；绑定当前控制连接。私有 ACK 返回本人身份、首次 secret、serverEpoch、serverTime。凭据错误明确报错，网络超时不自动生成新身份。
2. **room:create**：actionId。已认证且未占其他房间座位；创建房间、占A、返回房间码和邀请路径、发快照；重试不重复创建。
3. **room:join**：actionId、roomCode。检查存在、身份占座、容量；成功占空座、发快照。满房只返回 ROOM_FULL 和文案，不返回实例、version、phase、成员、棋盘，不加入广播组。
4. **room:resume**：actionId、roomCode、roomInstanceId、lastVersion。验证原身份仍拥有原实例座位，恢复在线、发完整快照。座位失效 SEAT_RELEASED；房间/实例失效 ROOM_EXPIRED，不静默加入复用房间码的新实例。
5. **room:sync**：actionId、roomInstanceId、lastVersion、syncRequestId。仅当前座位成员可获取完整快照，第三人无权读取。
6. **room:leave**：通用房间字段。只接受当前控制连接；playing认输释放，其他阶段释放但不改写已有胜负。关闭/刷新不等同主动离开。
7. **round:ready**：通用字段、roundId（首局为空）、ready布尔。waiting/finished当前成员使用；双方在线准备后一次性创建下一局、配色、重置准备。
8. **game:move**：通用字段、roundId、x、y、expectedMoveNo。校验本局、playing、未paused、本局参与者、轮次、0–14整数、空位、moveNo、未结束。原子落子/判定/换轮次后广播。客户端确认前只显示“落子中”。
9. **disconnect:resolve**：通用字段、roundId、targetPlayerId、decision=claim_win/keep_waiting。仅playing在线对手且目标离线超60秒。claim_win判负、释放、drawing；keep_waiting保留并暂停。与重连竞态以服务端处理顺序为准。
10. **stroke:begin**：通用字段、roundId、drawingId、strokeId、colorIndex、startPoint。只允许本局胜者、期限内、未使用机会。颜色固定六色索引；点位0–31整数；固定1逻辑像素粗细。创建临时笔画、冻结颜色并广播。
11. **stroke:points**：通用字段、roundId、drawingId、strokeId、seq、points。约50ms发批次；校验身份、阶段、期限、归属、连续seq、范围、频率。每批最多32点、整笔1024输入点、每秒约25批并允许小幅突发，消息体16KB。重复seq同内容只确认，不同内容拒绝；跳号要求补发或同步。服务端统一插值防断裂，每合法批次增加version、广播双方。
12. **stroke:end**：通用字段、roundId、drawingId、strokeId、lastSeq、pointCount。松开先发最后批次再结束；服务端核对批次完整、数量、期限，原子归档、更新画布revision、清临时笔画、finished。确认后才跨局保留。
13. **drawing:skip**：通用字段、roundId、drawingId。仅胜者；未开始跳过，已有临时笔画则丢弃不存档，finished。本人即时预览只是表现层，对方仅看服务端确认轨迹。
14. **wash:propose**：通用字段、roundId。waiting/finished且两人在线；生成proposalId，固定两人身份、两张脸revision、30秒期限，发起者已同意。
15. **wash:respond**：通用字段、proposalId、accept。只允许另一成员；接受时核对身份/阶段/画布/期限，原子清空当前两张脸。拒绝、掉线、换人、离开、阶段变化、超时均取消。

### S→C 消息

1. **server:hello**：protocolVersion、serverEpoch、serverTime，连接级信息不含房间。
2. **room:snapshot**：roomInstanceId、version、serverTime、可选syncRequestId、完整公开状态。含座位、棋盘、轮次、黑白、结果、paused、掉线/画脸期限、累计画布、有效临时笔画、洗脸提议；不含密钥、控制连接、幂等缓存、内部定时器。
3. **room:patch**：roomInstanceId、prevVersion、version、serverTime、可选causedByActionId、changes。changes为共享类型定义，支持座位、落子/轮次/阶段、准备、临时笔画、画布、洗脸提议。一次事务多变化同一patch，version增1；画笔每批次单独增1。完整子对象替换可作为轻量实现，不使用模糊合并。
4. **session:replaced**：同一身份被其他标签接管，旧标签停止操作和自动重连。
5. **room:expired**：房间销毁；连接恢复时也可通过私有错误表达。
6. **server:restarting**：退出前尽力通知，不保证送达或房间可恢复。

### 幂等、版本与重试

先验证身份/当前连接，再查actionId缓存，命中返回原结果；同ID异内容 ACTION_ID_REUSED。按身份/实例分区，数量与时间有上限。淘汰后仍依赖roundId、moveNo、drawingId、seq防二次写入。

客户端version<=当前则丢弃；prevVersion等于当前才应用；跳号停止应用并请求快照。快照替换后丢弃旧消息，只接续连续增量。重连先认证与快照后开放操作。ACK超时有限重试、沿用actionId；断线不无限排队过期业务操作，恢复后先看权威状态。

错误：AUTH_INVALID、IDENTITY_EXPIRED、ROOM_NOT_FOUND、ROOM_FULL、ROOM_EXPIRED、SEAT_RELEASED、NOT_YOUR_TURN、CELL_OCCUPIED、GAME_PAUSED、STALE_ROUND、INVALID_PHASE、DRAWING_EXPIRED、INVALID_STROKE_SEQ、RATE_LIMITED，以及参数校验错误。

## 5. 身份与房间生命周期

### 创建、加入、满房

身份建立后创建，分享/r/房间码或手输码，两人准备开始。服务端发状态/加入广播组前检查容量。两个座位含掉线保留均占用则满房，只给“房间已满”和“创建新房间”，不展示成员棋局。

### 刷新、掉线、恢复

刷新不认输；localStorage恢复身份再恢复房间。掉线服务端记录时间，playing暂停，对方显示“对方掉线，等待重连”。60秒内恢复原座并发快照；两人在线解除暂停。

60秒后不自动释放座位。在线对手可判赢或继续等待；未选择保持等待。60秒是不可判负宽限期，之后获得裁决权，不是强制踢人期限。

### 双方离线与销毁

双方不在线记录noConnectedPlayersSince，暂停而不判胜负。连续10分钟无人恢复即销毁房间、身份占座及笔迹；有效恢复或新人成功入座取消销毁计时；第三人满房访问不延长寿命。一方恢复时另一方已超60秒即可裁决。

### 主动离开、中途加入

playing主动离开认输空座，新人可加入原链接。冻结输家和目标仍是旧玩家，新人画布干净，drawing只显示旧输家的结算头像，新人等待结算，不能落子/画脸。finished双方准备开新局。不提供独立观战入口。

胜者drawing主动离开放弃临时笔画并finished；输家离开不改目标。原身份重入同房若有空座可恢复本人累计画布，不能抢回已被新人占用的座位。

### 画脸掉线

20秒服务端绝对时限不暂停。输家离线仍可画并保存其画布，恢复看快照。赢家掉线保留已接受临时笔画到期限但不自动归档。原页面确实收到松开且及时恢复可完整补交；刷新丢失真实松开与本地队列时不伪造结束、不获得第二笔，可跳过。到期未确认整笔丢弃。未开始的赢家及时恢复可用剩余时间开始。每消息再次查期限，不只靠timer。

### 同浏览器多窗口

同源localStorage共享，两普通标签同一身份。新标签接管，旧标签停止重连；controlEpoch拒绝旧Socket操作。测试用普通+无痕或不同浏览器，第三人第三独立存储；另测双标签身份接管。

### 服务重启

内存模式无法跨进程恢复。Render休眠/重启/部署后房间、棋局、身份和图案可能全失。只有收到明确失效响应才清理恢复记录，提示“服务器已重启，原房间无法恢复”，允许新建；不能把暂时连接失败当失效。

## 6. Render部署

同一个Web Service托管/、/r/:roomCode、/assets/*、/socket.io/*和/healthz。后端0.0.0.0监听process.env.PORT，本地默认3000；HTTP与WS共端口，前端同源连接，公网HTTPS/WSS，检查Origin。[2] [3]

render.yaml计划：name=small-web-game、type=web、runtime=node、显式plan=free、区域建议Singapore、buildCommand=npm ci && npm run build、startCommand=npm start、healthCheckPath=/healthz、NODE_ENV=production、锁定Node24补丁、单实例、不使用cluster、autoDeployTrigger=off防提交打断对局。[4]

前端产物dist/client、服务端dist/server，npm start启动编译后服务并托管前端。

### 部署步骤

1. 完成里程碑，将代码推送用户仓库，保留原内容与历史。
2. 依赖安装、类型检查、测试、生产构建通过。
3. Render登录，通过Git Provider连接并授权GitHub目标仓库。
4. New → Blueprint导入根目录render.yaml。
5. 核对Free、分支、区域、构建/启动命令。
6. 部署、查日志、/healthz通过。
7. 获取实际分配线上域名。
8. 两独立浏览器完整流程，第三个满房。
9. 手动重新部署，验证原房间失效提示。
10. README填入真实线上地址、步骤和限制；另提供New → Web Service手填替代流程。

### 免费档限制

官方说明连续15分钟无入站HTTP或WebSocket消息休眠，下次访问触发唤醒，通常约1分钟，不承诺固定几十秒。免费服务也可能任意重启。[5]

加载后未连接显示“正在连接服务器”，较久“服务器可能正在唤醒，请稍候”；断开显示“连接已断开，正在重连”并禁用状态变更，指数退避带抖动，上限约10秒；认证+快照后恢复。首次服务睡眠时HTML尚未返回，只能显示Render加载页，我们的提示不能提前出现。不加第三方定时保活。[3] [5]

## 7. 开发里程碑及验收

### M1 房间与权威联机五子棋

实现创建/加入、邀请链接与房间码、15×15棋盘、准备开始、轮次、服务端判胜负、基础actionId/version协议。无美术，先简单结算，不实现画脸表现。

验收：两独立客户端同局互见落子、轮次结果一致；非法轮次/越界/占位拒绝；同actionId不重复落子。横、竖、双斜、超过五连、边界、不连续单测通过。

### M2 身份与生命周期

localStorage身份恢复、掉线暂停重连快照、60秒裁决、主动认输、满房、再战换色、双标签接管、10分钟清理。

验收：刷新恢复；DevTools断网一致暂停与恢复；60秒前不能判负，之后两选择；第三人满房且无状态泄露；离开新人可入；原两人换色；旧局消息无效。

### M3 画脸与洗脸

放大脸部、32×32网格、一笔六色固定粗细、50ms批次、服务端限制、20秒、松开存档、跳过/平局跳过、累计画布、共同洗脸。

验收：对手实时轨迹；鼠标触摸；非胜者/越界/超时/第二笔/非法seq拒绝；快照正确；临时笔画不误存；双方同意；新人不继承前任画布或画脸目标。

### M4 表现与打磨

六类动画、五类音效、静音/自动播放、桌面手机布局、连接提示、胜负表现。

验收：动画对应权威状态，笔迹不丢；首次未交互不播放；全局静音；快照不重播；手机正常落子绘画且不误滚动。

### M5 上线与交付

render.yaml、GitHub CI、生产构建、部署、线上验证与README。

验收：真实线上地址；同域页面Socket；完整核心循环；满房弱网跳号恢复；冷启动等待；重部署明确失效；代码配置文档齐全。

## 8. 测试与交付

胜负单测：横、竖、两斜、五连以上、边界、不连续、满盘平局、胜后禁落子。同步：ACK丢失重试、重复消息、跳号、快照增量交错、重连/判负竞态。绘画：重复/乱序、范围/频率、缺批次、超时未松开、换人旧请求。使用可控时钟测20秒/60秒/10分钟。

浏览器用两独立身份走完整流程、第三独立身份满房，并DevTools弱网/断网验证。最终交付真实Render地址、GitHub源码测试、render.yaml、.env.example、锁文件、README。

README限制：纯内存，重启/休眠丢房间；免费唤醒慢；不支持水平扩容；本地凭据丢失不能找回；普通标签共享身份；超时未确认轨迹不保留。

## 9. 已确认的边界决策

1. 首局双方准备；原两人再战交换黑白，新组合A黑B白。
2. 60秒后不自动踢人；在线对手判赢或继续等，没选保持等。
3. 主动认输和超时判负奖励画脸，固定旧输家，新人不接管。
4. 画脸20秒不暂停；未完整确认不存档，刷新不得第二笔。
5. 洗脸清空当前两人全部笔迹；仅waiting/finished，另一人30秒确认。

### M2 实现细化

`session:open`的私有响应额外返回本人占座的房间入口`room`（房间码、实例、邀请路径或null），便于在首次加入确认丢失、localStorage房间记录不完整时恢复本人座位；不对第三人公开任何房间状态。`room:resume`确认返回同样的入口数据，可选携带`syncRequestId`关联快照。`room:leave`额外携带当前`roundId`（无对局为null），服务端拒绝旧局离开意图，避免迟到请求导致下一局认输。恢复后取得完整快照才开放落子。

M2尚未实现画脸，因此五连、主动认输和超时裁决暂时直接进入finished；M3再接入已确定的drawing环节。60秒裁决只适用于playing阶段；waiting/finished不追溯改写结果，也不自动释放保留座位，玩家可恢复或在线方主动离开另建房间。任意阶段双方连续离线10分钟销毁房间。

### M3 实现细化

累计`FaceCanvas.pixels`为1024个整数：`-1`透明，`0–5`对应固定六色。它保存全部确认笔迹，原始`strokes`仅保留最近4条，旧轨迹压平后视觉不丢失。前后端共享整数Bresenham插值，固定一格粗细。`stroke:begin`的起点计入总点数、`lastSeq=0`，之后批次从`seq=1`连续递增，`stroke:end.pointCount`是起点与全部已接收输入点总数。

`wash:propose.roundId`允许首局waiting时为null，其他情况绑定当前roundId；洗脸仍仅允许waiting/finished两人在线，不能单方清空。drawing额外冻结胜者和原输家昵称，替换座位不会改变结算目标。M3只加入静态像素脸作为绘画载体，完整小人动画和音效仍属于M4。

纯内存资源保护：单房间保留至多64个历史身份画布，容量包含当前两席。达到上限拒绝全新身份加入，并提示创建新房间；不删除任何既有画布，原有效身份仍可进入空座并恢复笔迹。双方同意洗脸只清图案，不改变身份归属或容量计数。

## References

[1]: https://socket.io/docs/v4/delivery-guarantees "Socket.IO Delivery guarantees"
[2]: https://render.com/docs/web-services "Render Web Services"
[3]: https://render.com/docs/websocket "WebSockets on Render"
[4]: https://render.com/docs/blueprint-spec "Render Blueprint specification"
[5]: https://render.com/docs/free "Render Free service limitations"
