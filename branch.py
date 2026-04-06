import re

with open("packages/dashboard/src/pages/index.astro", "r", encoding="utf-8") as f:
    text = f.read()

# 1. Substitute the initial active panel
text = text.replace(
    '  <!-- Step 1: Authorization -->\n  <div class="step-panel active" id="s1">',
    '''  <!-- Step 0: Mode Selection -->
  <div class="step-panel active" id="s0">
    <h2>🌟 欢迎 / Welcome</h2>
    <div class="subtitle">请选择您要进行的操作 / Please select an operation</div>
    <div class="flex" style="flex-direction:column; gap:16px;">
      <button class="btn btn-primary" id="modeCreateBtn" style="padding: 24px; font-size: 1.1rem; height: auto;">🤖 创建并部署全功能 Agent<br><span style="font-size:0.8rem; opacity:0.8; font-weight:normal; margin-top:8px; display:inline-block;">完整定型、配置概率并激活后台巡逻进程<br>Deploy active agent to background daemon</span></button>
      <button class="btn btn-ghost" id="modeDistillBtn" style="padding: 24px; font-size: 1.1rem; border: 1px solid var(--primary); height: auto;">🔍 仅体验账号推文人格蒸馏<br><span style="font-size:0.8rem; opacity:0.8; font-weight:normal; margin-top:8px; display:inline-block;">免部署精简体验，提取任何人格化 Prompt<br>Distill persona system prompt only without deploying</span></button>
    </div>
  </div>

  <!-- Step 1: Authorization -->
  <div class="step-panel" id="s1">'''
)

# 2. Add identity section wrapper in Step 3
text = text.replace(
    '''    <h2>🎭 Agent 身份 <span style='font-size:0.7em;color:var(--text-muted)'>/ Agent Identity</span></h2>
    <div class="subtitle">核心身份信息已与您的授权 X 账号强绑定。 / Agent core identity is securely bound.</div>
    
    <label>展示名称 / Display Name</label>''',
    '''    <div id="s3Title"><h2>🎭 Agent 身份 <span style='font-size:0.7em;color:var(--text-muted)'>/ Agent Identity</span></h2></div>
    <div class="subtitle" id="s3Subtitle">核心身份信息已与您的授权 X 账号强绑定。 / Agent core identity is securely bound.</div>
    <div id="identitySection">
    <label>展示名称 / Display Name</label>'''
)

text = text.replace(
    '''    <label>源账号（逗号分隔，不含 @ / comma separated, no @）</label>''',
    '''    </div>
    <label>源账号（逗号分隔，不含 @ / comma separated, no @）</label>'''
)

# 3. Add IDs to next buttons
text = text.replace(
    '''<button class="btn btn-primary btn-next" data-step="6">下一步 → / Next</button>''',
    '''<button class="btn btn-primary btn-next" id="s5next" data-step="6">下一步 → / Next</button>'''
)

# 4. Update JS logic
text = text.replace(
    "step: 1,",
    "step: 0,\n  mode: 'create',"
)

text = text.replace(
    '''const STEPS = ['授权/Auth','Gemini','身份/Identity','蒸馏/Distill','调教/Tune','经济/Param','记忆/Memory','部署/Deploy'];

function buildNav() {
  const nav = $('stepNav');''',
    '''const STEPS_CREATE = ['授权/Auth','Gemini','身份/Identity','蒸馏/Distill','调教/Tune','经济/Param','记忆/Memory','部署/Deploy'];
const STEPS_DISTILL = ['授权/Auth','Gemini','目标/Target','蒸馏/Distill','调教/Tune'];

function buildNav() {
  if (S.step === 0) { $('stepNav').innerHTML = ''; return; }
  const STEPS = S.mode === 'distill' ? STEPS_DISTILL : STEPS_CREATE;
  const nav = $('stepNav');'''
)

text = text.replace(
    '''function validate(step) {''',
    '''function validate(step) {
  if (S.mode === 'distill' && step >= 5) return true; // safety'''
)

text = text.replace(
    '''  const nav = $('stepNav');
  nav.innerHTML = '';
  STEPS.forEach((lbl, i) => {''',
    '''  const nav = $('stepNav');
  nav.innerHTML = '';
  STEPS.forEach((lbl, i) => {'''
)

text = text.replace(
    '''// Attach generic navigation listeners''',
    '''$('modeCreateBtn').addEventListener('click', () => { S.mode = 'create'; go(1); });
$('modeDistillBtn').addEventListener('click', () => { S.mode = 'distill'; go(1); });

// Attach generic navigation listeners'''
)

text = text.replace(
    '''  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  $('s' + n).classList.add('active');
  S.step = n;
  buildNav();
  if (n === 8) renderSummary();''',
    '''  if (S.mode === 'distill' && n > 5) return; // Prevent forward nav in distill mode
  
  if (n === 3) {
    if (S.mode === 'distill') {
      $('identitySection').style.display = 'none';
      $('s3Title').innerHTML = '<h2>🎯 目标源账号 <span style="font-size:0.7em;color:var(--text-muted)">/ Target Auth</span></h2>';
      $('s3Subtitle').innerText = '在此输入需要拉取推文进行蒸馏分析的源账号。 / Enter the source accounts to pull and distill.';
    } else {
      $('identitySection').style.display = 'block';
      $('s3Title').innerHTML = '<h2>🎭 Agent 身份 <span style="font-size:0.7em;color:var(--text-muted)">/ Agent Identity</span></h2>';
      $('s3Subtitle').innerText = '核心身份信息已与您的授权 X 账号强绑定。 / Agent core identity is securely bound.';
    }
  }
  
  if (n === 5) {
    if (S.mode === 'distill') $('s5next').style.display = 'none';
    else $('s5next').style.display = 'inline-flex';
  }

  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  $('s' + n).classList.add('active');
  S.step = n;
  buildNav();
  if (n === 8) renderSummary();'''
)

with open("packages/dashboard/src/pages/index.astro", "w", encoding="utf-8") as f:
    f.write(text)
