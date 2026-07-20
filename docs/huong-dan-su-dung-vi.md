# Hướng dẫn sử dụng SliceForge

SliceForge là AI Harness Engine chạy local-first để thực hiện thay đổi phần mềm trong Git worktree riêng, chạy các kiểm tra deterministic và chỉ đưa code vào project gốc sau khi người dùng chủ động promote.

Tài liệu này hướng dẫn cách dùng trong các tình huống thực tế. SliceForge không tự quyết định nghiệp vụ hoặc thiết kế thay product owner. Khi yêu cầu còn mơ hồ, cần làm rõ acceptance trước khi cho phép implementation.

## 1. Chuẩn bị

Yêu cầu tối thiểu:

- Node.js 20 trở lên.
- Git repository có initial commit.
- Một agent CLI: Codex, Claude Code, Cursor Agent hoặc generic JSON-protocol command (ví dụ Kilo Code chạy qua wrapper).
- Các công cụ mà project dùng trong gate: npm, pnpm, dotnet, uv, Poetry, Maven, Gradle hoặc công cụ tương ứng.

Cài đặt:

```bash
npm install -g @zeroltv/sliceforge
```

Kiểm tra project:

```bash
git status
git log -1
```

Project nên sạch. Thay đổi chưa commit sẽ khiến run và promote dừng để tránh ghi đè công việc đang làm.

## 2. Khởi tạo project

Từ thư mục gốc:

```bash
sliceforge init
```

Non-interactive:

```bash
sliceforge init --agent codex --yes
```

Lệnh này tự phát hiện stack và tạo:

- sliceforge.config.jsonc: agent, target, command, gate, policy và report.
- sliceforge.plan.yaml: danh sách slice và acceptance criteria.

`--yes` (non-interactive) nghĩa là lệnh chạy tự động đến cùng mà không dừng lại hỏi bất kỳ câu hỏi nào trên terminal. Ngược lại, `sliceforge init` không có `--yes` sẽ hiển thị các prompt chọn agent, stack để bạn trả lời theo kiểu tương tác (interactive). Tương tự, khi một task mơ hồ, CLI có thể hỏi tối đa ba câu hỏi; bạn có thể trả lời theo luồng tương tác (`sliceforge task answer <task-id>`) hoặc theo luồng non-interactive qua `--set` (xem mục 13).

Kiểm tra môi trường:

```bash
sliceforge doctor
sliceforge plan validate
```

Sửa mọi FAIL trước khi chạy. Xem xét mọi WARN, đặc biệt là shell command, browser capability và package manager.

Commit config và plan:

```bash
git add sliceforge.config.jsonc sliceforge.plan.yaml
git commit -m "Add SliceForge project configuration"
```

## 3. Cấu hình agent (Codex / Claude Code / Cursor / Kilo Code)

SliceForge giao tiếp với agent qua CLI. Có bốn kiểu agent (`type`) được hỗ trợ: `codex`, `claude`, `cursor` (đều có adapter tích hợp) và `command` (generic JSON-protocol, dùng cho Kilo Code hoặc bất kỳ CLI nào khác).

Mỗi agent được gán một `role` (implementer, testgen, reviewer, clarifier, planner) và capability tương ứng. Cấu hình nằm trong `sliceforge.config.jsonc`, trường `agents`.

### 3.1. Codex

Codex là adapter tích hợp sẵn. Mặc định lệnh gọi là `codex`, tự động thêm `--full-auto` khi ghi và `--sandbox read-only` khi chỉ đọc.

```jsonc
{
  "agents": {
    "implementer": { "type": "codex" },
    "testgen": { "type": "codex" },
    "reviewer": { "type": "codex" },
  },
}
```

Nếu muốn chỉ định model hoặc dùng binary khác:

```jsonc
{
  "agents": {
    "implementer": { "type": "codex", "command": "codex", "model": "gpt-5-codex", "timeoutMs": 600000 },
  },
}
```

Biến môi trường `OPENAI_API_KEY` được tự động đưa vào allowlist.

### 3.2. Claude Code

Adapter tích hợp gọi lệnh `claude`. Ở chế độ ghi dùng `--output-format json`; ở chế độ chỉ đọc thêm `--permission-mode plan`.

```jsonc
{
  "agents": {
    "implementer": { "type": "claude" },
    "planner": { "type": "claude" },
    "reviewer": { "type": "claude" },
  },
}
```

Chỉ định model:

```jsonc
{
  "agents": {
    "implementer": { "type": "claude", "model": "claude-opus-4-5" },
  },
}
```

Biến môi trường `ANTHROPIC_API_KEY` được tự động đưa vào allowlist.

### 3.3. Cursor Agent

Adapter tích hợp gọi lệnh `cursor-agent`. Ở chế độ ghi dùng `-p --force`; ở chế độ chỉ đọc dùng `-p`.

```jsonc
{
  "agents": {
    "implementer": { "type": "cursor" },
    "reviewer": { "type": "cursor" },
  },
}
```

### 3.4. Kilo Code (và mọi CLI khác) qua generic command

SliceForge chưa có adapter built-in cho Kilo Code, nên dùng `type: "command"` với một wrapper. Wrapper này phải:

- Đọc một JSON request từ **stdin**.
- Ghi đúng một JSON response (theo schema `protocolVersion`, `status`, `summary`, `artifacts`, `commandsRun`, `diagnostics`) ra **stdout**.
- Ghi mọi log người đọc ra **stderr**.

Ví dụ wrapper `kilo-wrapper.mjs` (chạy Kilo headless và chuyển đổi output về protocol của SliceForge):

```js
import { spawnSync } from "node:child_process";
import process from "node:process";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const res = spawnSync("kilo", ["run", req.prompt ?? "", "--json"], { encoding: "utf8" });
  const kiloOut = JSON.parse(res.stdout || "{}");
  process.stdout.write(
    JSON.stringify({
      protocolVersion: "1.0",
      status: kiloOut.ok ? "completed" : "failed",
      summary: kiloOut.summary ?? "",
      artifacts: kiloOut.filesChanged ?? [],
      commandsRun: [],
      diagnostics: [],
    }),
  );
});
```

Cấu hình trỏ vào wrapper:

```jsonc
{
  "agents": {
    "implementer": {
      "type": "command",
      "command": "node",
      "args": ["kilo-wrapper.mjs"],
      "capabilities": ["implementer"],
      "timeoutMs": 600000,
    },
    "reviewer": {
      "type": "command",
      "command": "node",
      "args": ["kilo-wrapper.mjs"],
      "capabilities": ["reviewer"],
    },
  },
}
```

Capability phải khai báo đúng: `implementer`, `testgen` hoặc `reviewer` (và `clarifier`, `planner` cho các role riêng). Nếu command lỗi hoặc response sai schema, engine fail closed chứ không âm thầm chuyển sang heuristic.

Với bất kỳ agent nào, luôn kiểm tra bằng:

```bash
sliceforge doctor
```

### 3.5. Kết hợp nhiều agent (ví dụ Cursor, Kilo Code, Codex cùng lúc)

Bạn không bị giới hạn một agent duy nhất. Mỗi role (`implementer`, `testgen`, `reviewer`, `clarifier`, `planner`) có thể gán cho một agent khác nhau. SliceForge gọi đúng agent theo role cần thiết trong từng stage.

Ví dụ thực tế: dùng **Codex** viết code, **Kilo Code** (qua wrapper) viết test, và **Cursor** làm reviewer:

```jsonc
{
  "agents": {
    "implementer": { "type": "codex", "model": "gpt-5-codex" },
    "testgen": {
      "type": "command",
      "command": "node",
      "args": ["kilo-wrapper.mjs"],
      "capabilities": ["testgen"],
      "timeoutMs": 600000
    },
    "reviewer": { "type": "cursor" }
  }
}
```

Hoặc nếu muốn cả ba agent đều tham gia đầy đủ (Codex implement, Claude planner, Cursor reviewer, Kilo Code testgen):

```jsonc
{
  "agents": {
    "implementer": { "type": "codex" },
    "planner": { "type": "claude" },
    "reviewer": { "type": "cursor" },
    "testgen": {
      "type": "command",
      "command": "node",
      "args": ["kilo-wrapper.mjs"],
      "capabilities": ["testgen"]
    }
  }
}
```

Một vài lưu ý khi kết hợp:

- Mỗi role chỉ nhận request khi stage tương ứng chạy. Ví dụ `planner`/`clarifier` chỉ chạy ở luồng `do` (xem mục 14); nếu không khai báo, engine dùng deterministic fallback.
- Role `reviewer` thường chạy ở gate `review`. Nếu bạn đặt `gates.review.advisory: true` (mặc định) thì finding của reviewer chỉ mang tính advisory và có thể `--accept-review`.
- Các agent khác loại có biến môi trường allowlist khác nhau (Codex: `OPENAI_API_KEY`, Claude: `ANTHROPIC_API_KEY`, Cursor/Kilo: không tự động). Nếu agent cần token, thêm vào `envAllowlist` của target command tương ứng, không commit vào config.
- Luôn chạy `sliceforge doctor` sau khi đổi cấu hình nhiều agent để xác minh từng CLI có mặt và đúng capability.

## 4. Cách viết slice

Một slice nên là một thay đổi nhỏ, có thể review và kiểm chứng độc lập. Không đưa cả epic hoặc một màn hình chưa rõ yêu cầu vào một slice implementation.

```yaml
schemaVersion: 1
slices:
  - id: validate-email
    title: Reject invalid registration email
    priority: 1
    targets: [app]
    acceptance:
      - id: EMAIL-001
        given: a registration request with an invalid email
        when: the request is submitted
        then: the API returns a validation error
    allowedPaths:
      - src/**
      - tests/**
    requiredGates:
      - build
      - lint
      - unit
```

Các trường quan trọng:

- id: duy nhất, chữ thường.
- targets: package hoặc service bị ảnh hưởng.
- acceptance: kết quả quan sát được.
- allowedPaths: nơi agent được sửa.
- requiredArtifacts: file bắt buộc phải tồn tại.
- requiredGates: bằng chứng deterministic bắt buộc.
- dependsOn: slice phải được promote trước đó.

Không nên viết "Improve checkout". Nên viết "Show a validation error when card token is missing".

## 5. Task mơ hồ hoặc chưa có thiết kế

Không chạy implementation nếu task chỉ nói "làm màn hình A" hoặc "cải thiện dashboard". Tạo một slice discovery chỉ tạo đặc tả:

```yaml
- id: define-screen-a
  title: Define Screen A product and interaction contract
  description: >
    Do not modify application source. Produce a decision-ready specification
    for Screen A, including layout, states, data, interactions and responsive behavior.
  priority: 1
  targets: [app]
  acceptance:
    - id: SCREEN-A-SPEC-001
      expected: docs/specs/screen-a.md defines the approved Screen A behavior
  allowedPaths:
    - docs/specs/**
  requiredArtifacts:
    - docs/specs/screen-a.md
  requiredGates:
    - artifact
    - review
```

Chạy và đọc proposal:

```bash
sliceforge run define-screen-a
sliceforge inspect <run-id>
```

Người có quyền quyết định cần xác nhận:

- Mục tiêu và người dùng của màn hình.
- Điểm vào và điểm rời màn hình.
- Dữ liệu hoặc API sử dụng.
- Loading, empty, error và success state.
- Các thao tác người dùng.
- Responsive và accessibility.
- Những gì nằm ngoài phạm vi.

Sau khi đặc tả được duyệt, tạo slice implementation có dependsOn define-screen-a. Acceptance nên mô tả từng state và hành vi cụ thể.

Artifact gate chỉ chứng minh file tồn tại. Nó không chứng minh nội dung đặc tả đúng, nên discovery vẫn cần human review.

## 6. Chạy một slice

Chạy slice cụ thể:

```bash
sliceforge run validate-email
```

Nếu không truyền ID, SliceForge chọn slice có priority thấp nhất và dependency đã hoàn thành:

```bash
sliceforge run
```

Theo dõi:

```bash
sliceforge status
sliceforge inspect <run-id>
sliceforge report <run-id>
```

State bình thường:

```text
planned -> preparing -> implementing -> validating -> reviewing -> ready_to_promote
```

Agent chỉ làm việc trong worktree riêng. Candidate được commit trước khi validation chạy. Gate không chạy trên project gốc.

Gate deterministic chạy theo thứ tự:

```text
artifact -> build -> lint -> unit -> integration -> e2e -> browser
```

## 7. Promote

Đọc diff và report trước:

```bash
sliceforge inspect <run-id>
```

Nếu trạng thái là ready_to_promote:

```bash
sliceforge promote <run-id>
```

Nếu reviewer advisory có finding:

```bash
sliceforge promote <run-id> --accept-review
```

Promote chỉ thành công khi original tree sạch, branch và HEAD không đổi, candidate commit đúng, fingerprint không đổi và Git tree sau cherry-pick khớp candidate.

SliceForge không tự merge và không tự promote.

## 8. Các case thực tế

### Working tree dirty

Lỗi thường gặp:

```text
Original working tree must be clean.
```

Xử lý:

```bash
git status
git add <files>
git commit -m "Save local work"
```

Hoặc stash:

```bash
git stash push -u -m "Before SliceForge run"
```

Không dùng git reset --hard nếu chưa chắc các file có thể xóa.

### Agent không cài hoặc sai capability

Chạy:

```bash
sliceforge doctor
```

Generic agent (kể cả Kilo Code qua wrapper) phải nhận một JSON request từ stdin và trả đúng một JSON response từ stdout. Log người đọc phải đi qua stderr. Capability phải khai báo đúng implementer, testgen hoặc reviewer.

### Agent chạy xong nhưng không sửa file

Nguyên nhân thường là task mơ hồ, allowedPaths không cho phép file cần sửa hoặc agent chỉ trả lời mô tả. Thu hẹp task, sửa plan rồi chạy lại:

```bash
sliceforge resume <run-id>
```

### Agent sửa ngoài allowedPaths

Run bị fail và không thể promote. Đọc policyViolations và sanitized diff. Chỉ mở rộng allowedPaths nếu file đó thực sự thuộc scope.

### Build, lint hoặc test fail

Xem gate đầu tiên fail:

```bash
sliceforge inspect <run-id>
```

Chỉ deterministic gate failure mới được retry tự động. Protocol, policy hoặc reviewer mutation sẽ dừng run ngay. Sửa code hoặc môi trường rồi resume.

### Dependency chưa được cài

Khai báo prepare ở target:

```jsonc
{
  "root": ".",
  "preset": "node",
  "prepare": {
    "command": "npm",
    "args": ["ci"],
    "timeoutMs": 600000
  }
}
```

Preparation chạy trong validation worktree. Nếu sửa tracked file như lockfile, run bị fail.

### HEAD gốc đã thay đổi

Xử lý:

```bash
sliceforge rebase <run-id>
sliceforge promote <run-id>
```

Rebase cập nhật candidate theo base mới, chạy lại policy, gates, fingerprint và reviewer. Không cherry-pick thủ công candidate khi run đang blocked.

### Reviewer có finding

Nếu review advisory, run chuyển sang needs_attention. Đọc finding trong report. Có thể sửa code, sửa acceptance hoặc chấp nhận có chủ ý bằng --accept-review. Không dùng option này để bỏ qua deterministic gate failure.

### Process bị treo hoặc chạy quá lâu

Hủy run:

```bash
sliceforge cancel <run-id>
```

SliceForge gửi cancellation request, kill process tree và dọn worktree. Nếu máy bị tắt đột ngột:

```bash
sliceforge resume <run-id>
```

Resource cũ không còn dùng có thể dọn bằng:

```bash
sliceforge clean
```

### Dependency slice chưa promote

Nếu implement-screen-a phụ thuộc define-screen-a, chạy trực tiếp sẽ bị chặn. Chạy và promote dependency trước:

```bash
sliceforge run define-screen-a
sliceforge promote <run-id>
sliceforge run implement-screen-a
```

### Browser gate không chạy

Browser gate cần command Playwright, JSON reporter, reportPath trong worktree và browser capability đã được doctor xác minh. Không thêm browser vào requiredGates khi capability chưa bật.

Khi bật `gates.browser.visual`, command phải tạo visual manifest theo schema publish trong package và PNG cho từng viewport cố định. Engine tự kiểm tra kích thước ảnh, runtime error, overflow, accessibility, missing asset và dùng `pixelmatch` so ảnh với baseline đã commit. Screenshot/manifest/diff chỉ được nằm trong `artifactDirectory`; symlink hoặc path trỏ vào source bị reject. AI visual review không thể thay thế gate này và nhận xét "đẹp/xấu" vẫn cần người duyệt.

### Verify trong CI

```bash
sliceforge verify --ci
```

## 9. Monorepo

Mỗi package hoặc service nên là một target:

```jsonc
{
  "targets": {
    "api": {
      "root": "services/api",
      "preset": "node",
      "commands": {
        "build": { "command": "npm", "args": ["run", "build"] },
        "unit": { "command": "npm", "args": ["run", "test"] },
      },
    },
    "web": {
      "root": "apps/web",
      "preset": "node",
      "dependsOn": ["api"],
      "commands": {
        "build": { "command": "npm", "args": ["run", "build"] },
        "unit": { "command": "npm", "args": ["run", "test"] },
      },
    },
  },
}
```

Slice chỉ định target bị ảnh hưởng. Engine tự thêm dependency target theo thứ tự topological. Không đặt target root hoặc command cwd ra ngoài project/worktree.

## 10. TestGen

```bash
sliceforge testgen validate-email
```

TestGen chỉ được ghi dưới docs/test-cases/**. Output phải có schema hợp lệ và cover các acceptance ID. TestGen không được sửa source implementation.

## 11. Secrets và bảo mật

Không đưa secret trực tiếp vào sliceforge.config.jsonc. Dùng envAllowlist:

```jsonc
{
  "command": "npm",
  "args": ["run", "integration"],
  "envAllowlist": ["DATABASE_URL"],
}
```

Không commit .env, private key, token, certificate hoặc credential file. Agent CLI và command adapter vẫn là trusted local tools do người dùng cấu hình.

## 12. Checklist trước promote

- [ ] doctor không còn FAIL.
- [ ] Acceptance mô tả kết quả kiểm chứng được.
- [ ] allowedPaths đủ hẹp.
- [ ] Required gates phù hợp với target.
- [ ] Diff không chứa secret hoặc file ngoài scope.
- [ ] Unit/integration/e2e đã pass.
- [ ] Reviewer finding đã được xử lý hoặc chấp nhận có chủ ý.
- [ ] Original working tree sạch.
- [ ] Report đã được đọc.

## 13. Lệnh nhanh

```bash
sliceforge init --agent codex --yes
sliceforge doctor
sliceforge plan validate
sliceforge run <slice-id>
sliceforge status
sliceforge inspect <run-id>
sliceforge report <run-id>
sliceforge promote <run-id>
sliceforge rebase <run-id>
sliceforge resume <run-id>
sliceforge cancel <run-id>
sliceforge clean
sliceforge verify --ci
```

## 14. Luồng Harness Engine dành cho người không muốn viết YAML

Tạo task trực tiếp từ mô tả thô:

```bash
sliceforge do "Làm màn hình quản lý người dùng có tìm kiếm, loading, empty và error state"
```

Có thể bổ sung input nhưng không bắt buộc:

```bash
sliceforge do "Làm lại màn hình A theo ảnh" --image ./screen-a.png
sliceforge do "Implement frame đã duyệt" --figma https://www.figma.com/design/...
sliceforge do "Làm task trong issue" --from ./issue.md
```

Nếu task mơ hồ, CLI trả về tối đa ba câu hỏi. Trả lời bằng interactive terminal hoặc `--set` (bản non-interactive):

```bash
sliceforge task answer <task-id>
sliceforge task answer <task-id> --set expected-outcome="User tạo và khóa tài khoản được"
```

Nếu config có `agents.clarifier` và `agents.planner`, hai role này nhận JSON request và phải trả đúng JSON response theo schema được publish trong package. Chúng chạy trong detached worktree chỉ đọc; ghi file, output sai schema, target ngoài scope, dependency cycle hoặc acceptance thiếu evidence đều làm task fail. AI chỉ đề xuất readiness và graph, không có quyền tự cho task pass.

Nếu bỏ riêng role `clarifier` hoặc `planner` khỏi config, stage tương ứng dùng deterministic fallback. Khi role đã được cấu hình mà command lỗi hoặc response sai, engine fail closed chứ không âm thầm chuyển sang heuristic.

Khi task đủ rõ, đọc plan và approve fingerprint:

```bash
sliceforge task inspect <task-id>
sliceforge task approve <task-id>
sliceforge queue start
```

Nếu không đồng ý với plan hoặc giao diện, tạo revision mới:

```bash
sliceforge task revise <task-id> --feedback="Dùng table gọn hơn và giữ filter trên mobile"
sliceforge task approve <task-id>
```

Queue chỉ chạy implementation và gates trong worktree riêng. Khi pass, nó dừng ở `ready_to_promote`:

```bash
sliceforge task list
sliceforge promote <run-id>
```

Không có option nào trong `do` hoặc `queue start` tự promote code.

Acceptance ở trạng thái `unverified` không thể promote, kể cả dùng `--accept-attention`. Flag này chỉ dành cho `manual_required` hoặc advisory review đã được người dùng đọc và chấp nhận.

## 15. Chạy nhiều task và phục hồi worker

```bash
sliceforge queue start --concurrency 2
sliceforge queue start --watch --poll-ms 5000
sliceforge queue status
sliceforge queue pause
sliceforge queue resume
```

Worker ghi lease và heartbeat. Nếu process chết, lease hết hạn được đưa về queue ở lần `queue start` tiếp theo. Task dừng khi thiếu approval, vượt budget, lặp cùng failure, gate fail hoặc có policy violation.

Các task dùng cùng target được chạy tuần tự. Integration, E2E và browser task khác target có thể chạy song song; mỗi run nhận một port lease riêng trên toàn máy và được inject qua `PORT`, `SLICEFORGE_PORT`. Lease được heartbeat khi chạy, release khi xong và tự hết hạn để recovery nếu process chết.

Với graph có nhiều slice, engine tạo branch/worktree staging riêng cho toàn task, chạy slice theo dependency và chỉ tích hợp slice đã verified. Khi toàn bộ graph xong, engine tạo một bundle commit có parent là base SHA ban đầu, chạy lại policy, artifact, gates, review và acceptance mapping của mọi slice trên bundle đó. Original tree vẫn không đổi và người dùng chỉ promote một bundle run cuối cùng.

Nếu worker chết giữa chừng, task record giữ pending run, các slice đã tích hợp và bundle run. Lần `queue start` sau tiếp tục từ recovery boundary này thay vì báo thành công một phần hoặc chạy lại mù quáng. Nếu HEAD gốc thay đổi, bundle bị block; chạy `sliceforge rebase <run-id>` sẽ kiểm tra lại toàn bộ slice trước khi cho promote.

Concurrency chỉ nên tăng khi máy đủ CPU/RAM. Port allocator tránh va chạm port giữa các repository SliceForge và bỏ qua port đang bị process ngoài chiếm, nhưng các service ngoài không dùng port vẫn cần target lock phù hợp. Promote vẫn thực hiện từng run và kiểm tra HEAD drift.

Trước stable release, chạy queue soak bằng Git repository, agent protocol, staging worktree và bundle thật:

```bash
npm run build
npm run soak:queue -w packages/engine -- --duration-ms 30000
npm run soak:queue -w packages/engine -- --duration-hours 24
```

Harness sẽ fail nếu task bị chạy trùng, bị mất, không tạo được bundle promotable, queue báo lỗi hoặc original worktree bị thay đổi. Nightly chạy bản ngắn; workflow thủ công nhận `soak_hours: 24` để tạo bằng chứng trước release.

## 16. Đánh giá model và phát hiện regression

```bash
sliceforge eval run evaluations/model-regression.json
sliceforge eval compare <evaluation-id> --baseline default
sliceforge eval accept-baseline <evaluation-id> --name default
```

Evaluation engine tự tạo context variants thay vì chỉ gửi nhãn cho evaluator: `reordered` đảo thứ tự context, `irrelevant` thêm context không liên quan đã khai báo (hoặc marker cố định), và `reduced` bỏ entry cuối. Engine chạy lặp từng case rồi đo success, acceptance evidence, schema compliance, policy violation, unsupported claim, behavior variance, changed-file variance trong cùng variant và giữa các variant, flaky gate, retry, thời gian và cost. Ngay cả lần chạy đầu chưa có baseline cũng bị fail nếu một trial fail, thiếu evidence, có claim không được chứng minh, gate flaky, lộ secret hoặc kết quả/file thay đổi không nhất quán. Không được chọn một evaluation đang fail làm baseline.

Model update không tự động được coi là an toàn. Chạy lại suite và so với baseline trước khi đổi model mặc định cho team. SliceForge ghi agent/model/CLI version drift nhưng không fail chỉ vì version string đổi nếu toàn bộ metrics vẫn đạt. Ngược lại, suite, harness config hoặc context fingerprint thay đổi sẽ block phép so sánh vì hai lần chạy không còn cùng điều kiện; phải review nguyên nhân rồi mới chấp nhận baseline mới.

## 17. Khi không ưng UI hoặc cần human approval

Visual/browser gate chỉ chứng minh các kiểm tra định lượng như runtime error, responsive overflow, accessibility hoặc screenshot baseline. Nó không chứng minh giao diện đẹp.

Khi run ở `needs_attention`, đọc report và diff. Nếu muốn sửa, tạo task revision mới với feedback cụ thể. Chỉ dùng lệnh dưới đây sau khi đã thật sự chấp nhận các điểm manual/review:

```bash
sliceforge promote <run-id> --accept-attention
```

Figma chỉ được đọc qua provider command do người dùng cấu hình. Nếu không có provider, URL được giữ như reference; SliceForge không tự gửi source hoặc token lên dịch vụ khác.

Lệnh này yêu cầu tree sạch, chạy gates trong detached worktree, không gọi write-capable agent, không commit và không promote.

## 18. Playbook case thực tế mở rộng

Phần này dùng để chọn đúng luồng khi yêu cầu không giống một task CRUD đơn giản. Quy tắc chung là: nếu chưa biết thế nào là kết quả đúng, hãy tạo discovery hoặc clarification trước; nếu đã biết kết quả đúng, hãy để engine lập graph và chạy gates.

### Case 1: Task rõ, thay đổi nhỏ trong một package

Ví dụ: "Thêm kiểm tra email trùng khi đăng ký, trả HTTP 409 và thêm unit test".

Luồng:

```bash
sliceforge do "Thêm kiểm tra email trùng khi đăng ký, trả HTTP 409 và thêm unit test"
sliceforge task inspect <task-id>
sliceforge task approve <task-id>
sliceforge queue start
sliceforge promote <run-id>
```

Kiểm tra trước khi approve: target đúng service, acceptance có status code/body cụ thể, allowedPaths không mở cả repository và unit gate trỏ đúng package.

### Case 2: Task chỉ có một câu và chưa biết phạm vi

Ví dụ: "Cải thiện dashboard". Không cho implementer tự đoán. Dùng `do`; nếu readiness bị block, trả lời các câu hỏi hoặc để planner tạo discovery slice. Discovery chỉ được ghi `docs/specs/**`, không được sửa source.

Acceptance discovery nên xác định: người dùng, mục tiêu, entry/exit point, dữ liệu, loading/empty/error/success, responsive, accessibility, ngoài phạm vi và cách nghiệm thu. Sau khi người có quyền quyết định duyệt spec, tạo revision implementation có `dependsOn` discovery.

### Case 3: Có Figma đã duyệt

```bash
sliceforge do "Implement user management screen" --figma "https://www.figma.com/design/..."
```

Figma URL chỉ là input reference. Muốn lấy frame, token hoặc asset phải cấu hình `inputs.figmaProvider` và kiểm tra bằng `doctor`. Planner phải ghi rõ frame nào, viewport nào, token nào được dùng và phần nào không nằm trong thiết kế.

Visual gate cần baseline PNG đã review, viewport cố định, không runtime error, không overflow, accessibility pass và không missing asset. Pixel pass không có nghĩa UX đã được duyệt; người dùng vẫn có thể `task revise` với feedback và tạo revision mới.

### Case 4: Chỉ có ảnh chụp màn hình, không có Figma

```bash
sliceforge do "Dựng lại màn hình từ ảnh tham chiếu" --image ./reference/dashboard.png
```

Ảnh được lưu trong runtime store và truyền cho agent có capability phù hợp. Không đưa ảnh vào Git project trừ khi đó là asset chính thức. Hãy ghi thêm những điều ảnh không thể chứng minh: API nào dùng, trạng thái loading/error, thao tác click, responsive ngoài viewport ảnh và accessibility.

### Case 5: Không có thiết kế nào

Tách thành hai revision:

1. Discovery tạo product/interaction contract.
2. Implementation dùng contract đã approve.

Không dùng screenshot được agent tự tạo làm "thiết kế đã duyệt". Screenshot tự sinh chỉ là evidence kỹ thuật; quyết định "đẹp, đúng brand, đúng UX" vẫn là manual approval.

### Case 6: API chưa tồn tại hoặc contract còn mơ hồ

Không để UI agent tự bịa response. Tạo graph gồm API contract, API implementation, UI và integration test. API slice phải chốt schema, auth, pagination, error code, idempotency và backward compatibility trước khi UI slice chạy. Nếu backend chưa sẵn sàng, cho phép UI dùng fixture rõ ràng và ghi fixture đó là assumption, không đánh dấu integration pass.

### Case 7: Backend đổi schema hoặc database migration

Chia thành migration, compatibility code, backfill/rollback và test. Acceptance phải có upgrade từ schema cũ, dữ liệu rỗng, dữ liệu lớn, rollback hoặc kế hoạch khôi phục. Migration không nên chạy vào database thật trong agent gate; dùng database fixture/container do người dùng cấu hình và giữ credential ngoài config.

### Case 8: Monorepo có API và web phụ thuộc nhau

Chọn cả target `api` và `web` khi task chạm contract chung. Engine chạy dependency theo thứ tự topological, không chạy `npm install` riêng ở từng package nếu root workspace quản lý lockfile. Acceptance nên tách phần API có thể verify độc lập và phần browser/integration cần cả hai target.

Nếu chỉ đổi `apps/web`, không chạy toàn bộ monorepo một cách mù quáng; để detector và target graph chọn gate bị ảnh hưởng cùng dependency bắt buộc.

### Case 9: Bug chỉ xảy ra thỉnh thoảng

Không retry vô hạn. Tạo acceptance tái hiện với điều kiện cụ thể: seed, timezone, concurrency, request sequence hoặc dữ liệu đầu vào. Bật log/artifact có giới hạn, chạy lặp bounded và ghi failure fingerprint. Nếu hai lần liên tiếp có cùng fingerprint, engine dừng `needs_attention` để người quyết định bổ sung evidence.

### Case 10: Unit test pass nhưng production bug vẫn có thể xảy ra

Thêm integration hoặc contract gate thay vì tăng số unit test cho có. Ví dụ cache race cần test nhiều worker; auth cần test token hết hạn và quyền khác nhau; file upload cần test binary lớn, path traversal và content type. Acceptance phải nói rõ hành vi quan sát được, không chỉ "code coverage tăng".

### Case 11: Test flaky

Xem `flaky gate rate`, duration và failure fingerprint trong evaluation/report. Không tắt gate chỉ vì nó đỏ. Kiểm tra clock, port, random seed, shared filesystem, thứ tự test và cleanup. Chỉ retry deterministic failure trong giới hạn; flaky lặp lại phải chuyển `needs_attention` và giữ evidence thất bại.

### Case 12: Agent nói "đã xong" nhưng không có thay đổi hoặc evidence

Đây là kết quả không pass. Engine tự tính changed files, kiểm tra artifact và chạy gate; `summary` của agent không có quyền thay thế evidence. Kiểm tra task có allowedPaths đúng không, command agent có thật sự ghi worktree không và acceptance có quá mơ hồ không.

### Case 13: Agent muốn sửa file ngoài scope

Không mở `allowedPaths` thành `**/*` chỉ để qua gate. Nếu file ngoài scope thật sự cần sửa, tạo revision hoặc slice riêng với ownership và acceptance riêng. Nếu là generated file, khai báo rõ nguồn sinh và gate kiểm tra reproducibility.

### Case 14: Reviewer không thích UI nhưng mọi gate deterministic đều pass

Đây là `manual_required`, không phải build failure. Ghi feedback có thể hành động, ví dụ "trên mobile filter bị che bởi keyboard", thay vì "xấu". Dùng:

```bash
sliceforge task revise <task-id> --feedback="Giữ filter sticky trên mobile và thêm trạng thái empty rõ ràng"
```

Revision mới giữ candidate cũ để so sánh. Chỉ dùng `--accept-attention` khi đã đọc report và chấp nhận có chủ ý.

### Case 15: Task cần cập nhật tài liệu

Public CLI, config schema, API hoặc workflow thay đổi thường có `docsImpact: required` hoặc `review`. Docs update phải nằm trong isolated candidate và có acceptance riêng. Nếu engine không chắc tài liệu nào bị ảnh hưởng, task dừng `needs_attention`; không để agent sửa hàng loạt docs không liên quan.

Docs gate nên kiểm tra file tồn tại, link không hỏng, command/example chạy được và schema reference còn đúng. Chỉ sửa README không đủ nếu public contract nằm ở configuration hoặc architecture docs.

### Case 16: Secret vô tình xuất hiện trong diff hoặc log

Dừng run, không promote, không paste secret vào prompt hoặc issue. Xoay vòng credential ngay nếu secret đã từng được ghi ra ngoài process an toàn. Sau đó xóa artifact/log runtime theo policy, kiểm tra report đã redact và thêm regression fixture để secret không xuất hiện lại. `envAllowlist` chỉ cấp biến cần thiết; không commit `.env`, private key hoặc token.

### Case 17: Package manager hoặc SDK không có trên máy

Chạy `sliceforge doctor` trước khi debug code. Nếu Maven, Gradle, .NET SDK, browser hoặc package manager thiếu, đó là environment error; không đánh dấu task là code failure. Cài đúng toolchain hoặc chạy CI fixture. Với project dùng wrapper (`mvnw`, `gradlew`), ưu tiên wrapper đã commit và kiểm tra quyền execute trên macOS/Linux.

### Case 18: Hai task cùng sửa một target

Queue sẽ serialize theo target lock. Không tự chạy hai task cùng package bằng hai terminal nếu muốn tránh cạnh tranh dependency, dev server hoặc generated files. Nếu hai task độc lập thật sự, tách target ownership; nếu cùng file, xếp dependency hoặc để task thứ hai chờ task thứ nhất promote/revise.

### Case 19: Worker chạy 24/24

Dùng process manager để giữ `queue start --watch`, nhưng worker không được tự promote. Nó dừng ở approval, ambiguity, budget, policy violation hoặc `ready_to_promote`. Theo dõi `queue status`, lease và report directory; đặt retention để không đầy đĩa. Trước stable release chạy soak 24 giờ và kiểm tra không có task duplicate/lost.

### Case 20: Máy hoặc terminal bị tắt giữa state transition

Khởi động lại cùng project rồi chạy:

```bash
sliceforge queue start
sliceforge resume <run-id>
```

Engine đọc state atomic và event journal, nhận diện pending run/bundle/worktree và resume từ recovery boundary. Không xóa runtime store thủ công trước khi `inspect`; nếu xóa mất journal thì mất khả năng chứng minh trạng thái cũ.

### Case 21: Người khác đã commit vào branch gốc

Run bị `blocked` vì HEAD drift. Không cherry-pick candidate bằng tay. Chạy `rebase`, để engine cập nhật base, chạy lại toàn bộ gate bị ảnh hưởng và kiểm tra fingerprint, sau đó mới promote. Nếu conflict phản ánh yêu cầu đã đổi, tạo task revision thay vì cố giữ candidate cũ.

### Case 22: Generated code hoặc lockfile thay đổi ngoài dự kiến

Xác định command nào sinh file. Nếu lockfile thay đổi là bắt buộc, đưa prepare/install vào target và cho acceptance kiểm tra reproducible install. Nếu generated output không thuộc task, thêm protected/forbidden path hoặc cleanup trong command. Không commit artifact tạm chỉ để làm diff "trông có vẻ đầy đủ".

### Case 23: Symlink, binary hoặc file rất lớn

Không mở nội dung symlink trỏ ra ngoài worktree. File binary/ảnh chỉ truyền qua attachment capability và bị giới hạn kích thước. Diff lớn phải được bounded/redact; nếu cần review binary, tạo artifact checksum/kích thước và gate chuyên biệt thay vì nhét toàn bộ vào prompt/report.

### Case 24: Model hoặc agent CLI vừa được cập nhật

Không đổi version rồi tiếp tục coi baseline cũ là bằng chứng. Chạy evaluation suite với cùng task, context variants và config fingerprint; so task success, acceptance verification, schema compliance, policy violation, unsupported claim, variance và flaky gate. Regression safety hoặc acceptance evidence là lý do block, không phải riêng chuỗi version thay đổi.

### Case 25: Task phình scope giữa chừng

Không sửa trực tiếp task đã approve. Dùng `task revise` để tạo revision mới, ghi feedback/assumption và chạy lại clarification/planning. Revision làm fingerprint cũ không còn hợp lệ; candidate cũ vẫn giữ để audit và so sánh, nhưng không được promote cho yêu cầu mới.

### Case 26: Project chưa phải Git repository hoặc chưa có initial commit

Đây là điều kiện không thể bỏ qua vì worktree, base SHA và promote đều phụ thuộc Git. Khởi tạo repository, tạo initial commit chứa trạng thái hiện tại rồi chạy `init`/`doctor`. Không dùng SliceForge trên thư mục tạm chưa có lịch sử nếu cần audit hoặc recovery.

### Bảng chọn luồng nhanh

| Tình huống                | Luồng nên dùng                                   | Không được làm                       |
| ------------------------- | ------------------------------------------------ | ------------------------------------ |
| Yêu cầu rõ, acceptance rõ | `do -> approve -> queue -> promote`              | Cho agent sửa thẳng project gốc      |
| Thiếu behavior/design     | `do -> clarify/discovery -> approve -> revise`   | Đoán UX từ một câu prompt            |
| Có Figma/ảnh              | `do --figma/--image -> visual/manual review`     | Coi pixel pass là UX approval        |
| API chưa rõ               | Contract slice -> API -> UI -> integration       | Bịa response trong UI                |
| Build/test fail           | Inspect failure -> repair bounded -> rerun gates | Retry vô hạn hoặc bỏ gate            |
| HEAD drift                | `rebase -> gates -> promote`                     | Cherry-pick candidate thủ công       |
| Worker crash              | `queue start`/`resume` -> inspect journal        | Xóa runtime state mù quáng           |
| Model update              | `eval run -> compare -> accept-baseline`         | Tin baseline cũ tự động              |
| Secret/policy violation   | Block, rotate secret, inspect report             | Promote hoặc paste secret vào prompt |

## 19. Frontend và backend ở hai repository

Khi frontend và backend nằm ở hai Git repository khác nhau, hãy coi API contract là điểm nối giữa hai bên. Mỗi repository có config, worktree, queue, report và promote riêng. SliceForge hiện chưa có một giao dịch promote nguyên tử xuyên nhiều repository, vì vậy không giao một prompt để agent tự sửa cả hai thư mục.

### Case 27: Một developer làm cả frontend và backend

Task ví dụ: "Thêm màn hình chỉnh sửa cấu hình người dùng và API lưu cấu hình". Tách thành:

```text
API contract
  -> backend implementation + backend tests
  -> frontend integration + frontend tests
  -> cross-repository verification
  -> promote backend
  -> promote frontend
```

Luồng nên dùng:

1. Chạy `sliceforge do` ở backend để chốt endpoint, request, response, validation, authorization và error code.
2. Approve/promote backend khi contract artifact và test đã pass.
3. Đưa OpenAPI/schema hoặc contract artifact đã duyệt làm input cho task frontend.
4. Chạy frontend với mock/fixture trước, sau đó chạy contract hoặc integration test với backend thật.
5. Promote backend trước rồi frontend; ghi hai commit SHA cùng một task/issue.

Không đổi breaking contract ở cả hai repository trong cùng một lần mà không có compatibility plan. Nếu đổi field, ưu tiên backend hỗ trợ cũ và mới, chuyển frontend, rồi xóa field cũ bằng task riêng.

### Case 28: Chỉ làm frontend, backend chưa sẵn sàng

Frontend có thể làm trước bằng OpenAPI/schema, mock server hoặc fixture JSON. Report phải phân biệt rõ:

```text
UI behavior with fixture: verified
Integration with live backend: unverified
```

Acceptance nên bao phủ loading, empty, error, success, validation, permission denied và retry. Không kết luận "đã tích hợp" chỉ vì mock pass; khi backend có contract thật phải chạy lại integration/browser gate.

### Case 29: Chỉ làm backend, frontend chưa tồn tại

Backend vẫn có thể hoàn thành độc lập. Slice graph nên tách:

```text
schema/contract -> migration -> domain/application -> controller -> tests -> docs
```

Acceptance cần kiểm tra status code, response schema, authorization, dữ liệu cũ, dữ liệu rỗng, validation, idempotency và error response. OpenAPI/schema là artifact để frontend dùng sau; không cần chờ UI mới verify được API.

### Case 30: Frontend gọi sai URL, method hoặc response shape

Dấu hiệu là backend test pass nhưng browser nhận `404`, `405` hoặc lỗi parse dữ liệu. Cách xử lý:

1. So request thực tế của frontend với contract artifact.
2. Chạy contract test ở boundary, ghi method/path/body/response vào evidence.
3. Sửa đúng owner: URL/mapping ở frontend, schema/route ở backend.
4. Chạy lại gate bị ảnh hưởng ở cả hai repository.

Không sửa backend để chiều một typo frontend nếu contract đã approve; hãy tạo revision có lý do rõ ràng.

### Case 31: Authentication hoặc permission khác giữa local và production

Tạo test matrix cho anonymous, user thường, user có quyền, token hết hạn và resource không thuộc quyền. Không dùng `admin=true` hoặc bỏ middleware để làm test xanh. Secret chỉ đi qua `envAllowlist`; report không ghi token.

Nếu frontend nhận `401` nhưng backend trả `403`, đó là contract/product decision cần ghi vào acceptance, không để agent tự đổi tùy ý.

### Case 32: CORS, cookie hoặc CSRF chỉ lỗi trên browser

Unit test API có thể pass nhưng browser fail preflight hoặc không gửi cookie. Bổ sung browser/integration evidence với origin thật, credentials mode, OPTIONS request, CSRF token và SameSite policy. Không mở `Access-Control-Allow-Origin: *` chỉ để qua test.

### Case 33: Migration đã promote nhưng frontend chưa tương thích

Dùng mô hình expand/contract:

```text
expand schema -> backend đọc/ghi tương thích -> frontend chuyển field -> contract schema cũ
```

Mỗi bước có rollback/recovery plan. Migration không chạy vào database production từ agent; dùng database fixture/container và yêu cầu human approval cho rollout thật.

### Case 34: API chạy được nhưng frontend không lấy được dữ liệu

Chạy `sliceforge doctor` và kiểm tra API base URL, port lease, proxy rewrite, certificate/DNS, Docker network và seed data. Phân biệt environment failure với code failure; không sửa code để che việc thiếu service hoặc sai `.env`.

### Case 35: Pagination, sorting hoặc timezone không đồng nhất

Contract phải chốt page numbering, sort order, cursor/offset, timezone và format ngày giờ. Test trang đầu/cuối, dữ liệu trùng timestamp, timezone khác UTC và locale khác nhau. Frontend không tự đổi thứ tự nếu backend đã cam kết thứ tự.

### Case 36: Optimistic update thất bại

Acceptance phải có pending và rollback khi server từ chối. Browser gate kiểm tra request, response và state sau lỗi hoặc retry; click đổi màu nút không phải evidence đủ.

### Case 37: Upload file hoặc dữ liệu binary

Tách contract cho content type, giới hạn kích thước, tên file, validation, progress, cancel và retry. File fixture nằm trong runtime store, không nhúng binary lớn vào prompt/report. Test file rỗng, file quá lớn, path traversal và upload bị ngắt.

### Case 38: WebSocket, SSE hoặc long-polling

Cần fixture server và acceptance cho connect, reconnect, heartbeat, duplicate event, event ordering, auth expiry và cleanup khi rời trang. Port lease và cancellation phải được giải phóng khi test dừng.

### Case 39: Generated client hoặc shared package

Nếu frontend dùng client sinh từ OpenAPI, backend contract change phải chạy generator trong isolated worktree và kiểm tra diff generated. Không sửa tay file generated khi source schema chưa đổi. Ghi package version vào report để phát hiện drift.

### Case 40: Một repository pass nhưng hệ thống tích hợp fail

Tạo integration task dùng commit cụ thể của cả hai bên. Report cần ghi:

```text
frontend commit: <sha>
backend commit: <sha>
contract fingerprint: <fingerprint>
integration evidence: verified/unverified
```

Nếu chưa có cross-repository orchestration, người dùng giữ checklist liên kết hai run và promote theo thứ tự. Không tạo một status "pass" chung khi chỉ một repository đã pass.

### Case 41: Rollback sau khi backend đã promote

Không rollback frontend độc lập nếu frontend phụ thuộc contract mới. Xác định compatibility, rollback theo thứ tự an toàn, rồi chạy lại smoke/contract gates. Ghi rollback như một task có acceptance; không reset branch đang làm việc một cách mù quáng.

### Case 42: Feature flag hoặc rollout theo nhóm

Acceptance phải nói rõ flag mặc định, nhóm bật/tắt, behavior khi flag thiếu và cách audit. Test cả hai nhánh flag; browser evidence ghi context người dùng. Không bật flag production chỉ để nhìn thấy UI local.

### Checklist liên repository

- [ ] Backend contract đã approve và có fingerprint.
- [ ] Frontend đang dùng đúng version/schema contract.
- [ ] Mock/fixture được phân biệt với integration thật.
- [ ] Auth, CORS, cookie và permission đã có evidence.
- [ ] Migration có compatibility và rollback plan.
- [ ] Frontend/backend commit SHA được ghi trong report hoặc issue.
- [ ] Contract/integration gate chạy lại sau mọi mutation.
- [ ] Promote theo thứ tự an toàn; không giả lập atomic promote khi engine chưa hỗ trợ.
