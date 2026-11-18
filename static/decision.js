const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const TABS = ['dilemmas', 'evaluation', 'llm'];
const CHECKS = {
  decision_matches_rule: 'Decision matches its own rule',
  names_its_choice: 'Names its choice',
  cites_influential_factors: 'Cites the factors that mattered',
  cites_no_ignored_factor: 'Cites no factor its rule ignores',
  numbers_traceable: 'Every number is traceable',
};
const UNAVAILABLE = 'LLM service unavailable — the deterministic lab still works.';
const CHOICE = {stay: 'Stays', swerve: 'Swerves'};
let sceneAgent = 0;
let catalog;
let selectedId = null;
let report = null;
let llmStatus = null;
let llmResults = null;
let llmMessage = '';
let llmRunning = false;
let llmLast = null;
let llmLoaded = false;
let llmRepeat = false;
const detailCache = {};

const api = async (path, method = 'GET', body) => {
  const response = await fetch(path, {method, headers: {'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
  }
  return response.json();
};
const showError = (message) => { $('dl-error').textContent = message; $('dl-error').hidden = !message; };
const agentName = (id) => catalog?.agents.find((a) => a.id === id)?.name || id;
const FEATURE_LABELS = {count: 'People in each lane', age: 'Age', species: 'People or dogs', lawful: 'Crossing signal', role: 'Pedestrians or passengers', intervention: 'Lane positions', probability: 'Fatality risk'};
const featureLabel = (id) => FEATURE_LABELS[id] || catalog?.features[id] || id;
const changeLabel = (d) => {
  const lane = d.side === 'stay' ? 'Stay' : 'Swerve';
  if (d.feature === 'count') return `Add 2 to ${lane.toLowerCase()} lane`;
  if (d.feature === 'age') return `${lane} lane: ${d.change.includes('elderly') ? 'older adults' : d.change.includes('children') ? 'children' : 'adults'}`;
  if (d.feature === 'species') return `${lane} lane: ${d.change.endsWith('become dogs') ? 'dogs' : 'people'}`;
  if (d.feature === 'lawful') return `${lane} lane: ${d.change.includes('red signal') ? 'red' : 'green'} light`;
  if (d.feature === 'role') return `Swerve lane: ${d.change.includes('become passengers') ? 'passengers' : 'pedestrians'}`;
  if (d.feature === 'intervention') return 'Swap the lane positions';
  if (d.feature === 'probability') return `${lane} lane: ${d.change.match(/\d+%/)?.[0] || ''} fatal risk`;
  return d.change;
};
const fmt = (value) => (typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : value);
const scoreText = (scores) => Object.entries(scores).map(([lane, value]) => `${lane}: ${value && typeof value === 'object' ? Object.entries(value).map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmt(v)}`).join(', ') : fmt(value)}`).join(' · ');

/* ---- shared audit renderer ---- */
const auditHtml = (audit) => {
  if (!audit) return '';
  const rows = Object.entries(CHECKS).map(([key, label]) => {
    const ok = audit.checks?.[key];
    return `<li><span class="${ok ? 'ok' : 'no'}" aria-hidden="true">${ok ? '✓' : '✗'}</span><span>${escapeHtml(label)}<span class="sr-only">: ${ok ? 'passed' : 'failed'}</span></span></li>`;
  }).join('');
  const extra = [['Missing factors', audit.missing], ['Ignored factors cited', audit.ignored_cited], ['Stray numbers', audit.stray_numbers]]
    .filter(([, list]) => list?.length).map(([label, list]) => `<div class="dl-audit-extra">${label}: ${list.map((x) => escapeHtml(x)).join(', ')}</div>`).join('');
  return `<div><div class="dl-section-title">Explanation audit ${audit.passed ? '<span class="dl-badge good">passed</span>' : '<span class="dl-badge bad">failed</span>'}</div><ul class="dl-audit">${rows}</ul>${extra}</div>`;
};

/* ---- tabs ---- */
const showTab = (name, focus) => {
  TABS.forEach((tab) => {
    const selected = tab === name;
    const button = $(`tab-${tab}`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`panel-${tab}`).hidden = !selected;
    if (selected && focus) button.focus();
  });
  if (name === 'evaluation') loadReport();
  if (name === 'llm') loadLlm();
};
const initTabs = () => {
  document.querySelector('.dl-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) showTab(button.dataset.tab);
  });
  document.querySelector('.dl-tabs').addEventListener('keydown', (event) => {
    const index = TABS.findIndex((tab) => $(`tab-${tab}`) === document.activeElement);
    if (index < 0) return;
    const next = {ArrowRight: (index + 1) % TABS.length, ArrowLeft: (index + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    showTab(TABS[next], true);
  });
};

/* ---- dilemmas ---- */
const byId = (id) => catalog?.dilemmas.find((d) => d.id === id);
const baseOf = (id) => { const d = byId(id); return d?.base || id; };
const hashId = () => {
  try { return decodeURIComponent((location.hash.match(/dilemma=([^&]+)/) || [])[1] || ''); }
  catch { return ''; }
};
const select = (id, push = true) => {
  if (!byId(id)) { id = catalog.dilemmas.find((d) => !d.base).id; push = true; }
  selectedId = id;
  if (push && hashId() !== id) history.replaceState(null, '', `#dilemma=${encodeURIComponent(id)}`);
  renderList();
  renderVariation();
  loadDilemma();
  if (llmLoaded) { llmResults = null; renderLlm(); refreshStatus().then(refreshResults); }
};
const renderList = () => {
  const base = baseOf(selectedId);
  $('dl-list').innerHTML = catalog.dilemmas.filter((d) => !d.base).map((d) => `<button class="dl-item" data-id="${escapeHtml(d.id)}" ${d.id === base ? 'aria-current="true"' : ''}>${escapeHtml(d.title)}</button>`).join('');
};
const renderVariation = () => {
  const base = baseOf(selectedId);
  const groups = {};
  catalog.dilemmas.filter((d) => d.base === base).forEach((d) => { (groups[d.feature] ||= []).push(d); });
  const press = (id) => `aria-pressed="${id === selectedId}"`;
  $('dl-variation').innerHTML = `<div class="dl-card dl-variation"><div class="dl-section-title">Change one feature at a time</div>
    <div class="dl-var-group"><span class="dl-var-label">Starting point</span><div class="dl-var-btns"><button class="dl-chipbtn" data-id="${escapeHtml(base)}" ${press(base)}>Base case</button></div></div>
    ${Object.entries(groups).map(([feature, list]) => `<div class="dl-var-group"><span class="dl-var-label">${escapeHtml(featureLabel(feature))}</span><div class="dl-var-btns">${list.map((d) => `<button class="dl-chipbtn" data-id="${escapeHtml(d.id)}" ${press(d.id)}>${escapeHtml(changeLabel(d))}</button>`).join('')}</div></div>`).join('')}</div>`;
};
const castIcons = (lane, limit = 7) => {
  const people = lane.characters.flatMap((character) => Array(Math.min(character.count, limit)).fill(character)).slice(0, limit);
  return people.map((person, index) => {
    const x = index * 18 + 2;
    return person.kind === 'dog'
      ? `<g class="cast-dog" transform="translate(${x} 5)"><path d="M2 12 4 7l4-2 5 2 2 4-2 2v5h-2v-4H6v4H4v-5zM4 7 2 4l2-1 3 3m6 1 2-3 2 1-1 4"/><circle cx="11" cy="8" r=".7"/></g>`
      : person.kind === 'child'
        ? `<g class="cast-person child" transform="translate(${x} 6)"><circle cx="7" cy="4" r="2.5"/><path d="M5 8h4l2 7H3zM5 14l-1 6m5-6 2 6M4 10 1 14m9-4 3 4"/></g>`
        : person.kind === 'elderly'
          ? `<g class="cast-person elderly" transform="translate(${x} 2)"><circle cx="7" cy="4" r="3"/><path d="M5 8h4l2 9H3zM5 16l-1 9m5-9 2 9M4 10 1 14m9-4 3 4M4 2h6"/></g>`
          : `<g class="cast-person adult ${index % 2 ? 'woman' : 'man'}" transform="translate(${x} 2)"><circle cx="7" cy="4" r="3"/><path d="${index % 2 ? 'M5 8h4l4 8H1zM5 15l-1 10m5-10 2 10M4 10 1 15m9-5 3 5' : 'M4 8h6l1 9H3zM5 16l-1 9m5-9 2 9M4 10 1 15m9-5 3 5'}"/></g>`;
  }).join('');
};
const castHtml = (lane) => `<svg class="dl-cast" viewBox="0 0 ${Math.max(1, Math.min(7, lane.characters.reduce((sum, person) => sum + person.count, 0))) * 18} 30" role="img" aria-label="${escapeHtml(lane.text)}">${castIcons(lane)}</svg>`;
const laneHtml = (title, lane, risk) => `<div class="dl-lane"><h3>${title}${risk ? '<span class="dl-badge amber">risk-framed</span>' : ''}</h3>${castHtml(lane)}<p>${escapeHtml(lane.text)}</p></div>`;
const sceneHtml = (d) => {
  const outputs = d.outputs;
  sceneAgent = Math.min(sceneAgent, outputs.length - 1);
  const output = outputs[sceneAgent];
  const chosen = output.choice;
  const laneCard = (lane, y) => `<g transform="translate(0 ${y})"><rect x="18" y="-19" width="104" height="38" rx="8" fill="#e4ebe2" stroke="#9aac97"/><g transform="translate(25 -15)">${castIcons(lane)}</g></g>`;
  const selectedLane = d.lanes[chosen];
  return `<section class="dl-scene" aria-label="Visual decision summary"><div class="dl-scene-bar"><span><i></i> DECISION VIEW</span><span>${escapeHtml(d.title)}</span></div><div class="dl-scene-tabs" role="tablist" aria-label="Choose an agent decision">${outputs.map((o,i)=>`<button role="tab" aria-selected="${i===sceneAgent}" tabindex="${i===sceneAgent?0:-1}" data-scene-agent="${i}">${escapeHtml(o.name)}</button>`).join('')}</div><div class="dl-scene-body"><div class="dl-scene-graphic"><svg viewBox="0 0 520 154" role="img" aria-label="${escapeHtml(output.name)} chooses to ${chosen}. The car's path leads to ${escapeHtml(selectedLane.text)}"><path class="scene-road" d="M178 77H484"/><path class="scene-dash" d="M194 77H468"/><path class="scene-route ${chosen}" d="${chosen==='stay'?'M205 77H337':'M205 77Q270 77 337 32'}"/><path class="scene-arrow ${chosen}" d="${chosen==='stay'?'M329 68L345 77L329 86Z':'M329 24L347 29L335 44Z'}"/><g class="scene-car" transform="translate(153 77)"><rect x="-29" y="-17" width="57" height="34" rx="10"/><rect x="-18" y="-12" width="34" height="12" rx="4"/><circle cx="-17" cy="17" r="4"/><circle cx="17" cy="17" r="4"/></g><text x="18" y="22" class="scene-lane">SWERVE</text><text x="18" y="145" class="scene-lane">STAY</text><g transform="translate(398 0)">${laneCard(d.lanes.stay,77)}${laneCard(d.lanes.swerve,32)}</g></svg></div><div class="dl-scene-verdict"><span class="eyebrow">${escapeHtml(output.name)} decides</span><strong class="${chosen}">${CHOICE[chosen]}</strong><span>${escapeHtml(CHOICE[chosen])} lane · ${escapeHtml(selectedLane.text)}</span><p>${escapeHtml(output.explanation)}</p></div></div></section>`;
};
const agentCard = (o, d) => {
  const meta = catalog.agents.find((a) => a.id === o.agent);
  const b = o.base;
  const violation = b && b.expected === 'invariant' && b.changed && !o.tie && !b.tie;
  const delta = b ? `<div class="dl-delta"><div>Base: ${CHOICE[b.choice]} → now ${CHOICE[o.choice]}</div>
      <div><span class="dl-badge ${b.expected === 'sensitive' ? 'teal' : ''}">expected ${b.expected}</span> <span class="dl-badge ${b.changed ? 'amber' : ''}">${b.changed ? 'the spared lane changed' : 'the same lane is spared'}</span></div>
      ${violation ? `<div class="dl-alert">Consistency violation: ${escapeHtml(featureLabel(d.feature))} is outside this agent's rule, yet its decision changed.</div>` : ''}</div>` : '';
  return `<article class="dl-agent ${violation ? 'violation' : ''}"><div><h3>${escapeHtml(o.name)}</h3><div class="dl-concept">${escapeHtml(meta?.concept)}</div></div>
    <details><summary>Rule</summary><p>${escapeHtml(meta?.rule)}</p></details>
    <div class="dl-choice">${CHOICE[o.choice]}${o.tie ? '<span class="dl-badge amber">tie → default</span>' : ''}<span class="dl-badge">spares ${o.choice === 'stay' ? 'swerve' : 'stay'} lane</span></div>
    <div class="dl-scores">${escapeHtml(scoreText(o.scores))}</div>
    <p class="dl-expl">${escapeHtml(o.explanation)}</p>
    <details><summary>Numeric trace</summary><ol class="dl-trace">${o.trace.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol></details>
    <div><div class="dl-section-title">Factors used</div><div class="dl-chips">${o.factors_used.map((f) => `<span class="dl-chip">${escapeHtml(featureLabel(f))}</span>`).join('')}</div></div>
    ${auditHtml(o.audit)}${delta || '<div class="dl-delta dl-delta-spacer" aria-hidden="true"></div>'}</article>`;
};
const renderCase = (d) => {
  const risk = d.risk_framed;
  $('dl-case').innerHTML = `<div class="dl-case-head"><h2>${escapeHtml(d.title)}${d.base ? ` <span class="dl-badge teal">${escapeHtml(d.change)}</span>` : ''}</h2><p class="muted">${escapeHtml(d.description)}</p></div>
    <div class="dl-lanes">${laneHtml('Stay (no intervention)', d.lanes.stay, risk)}${laneHtml('Swerve (intervention)', d.lanes.swerve, risk)}</div>
    <div class="dl-unan ${d.unanimous ? '' : 'split'}">${d.unanimous ? `All four agents spare the ${d.outputs[0].choice === 'stay' ? 'swerve' : 'stay'} lane.` : 'The agents disagree: they do not all spare the same people.'}</div>
    ${sceneHtml(d)}
    <div class="dl-agents">${d.outputs.map((o) => agentCard(o, d)).join('')}</div>`;
};
document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-scene-agent]');
  if (!tab) return;
  sceneAgent = Number(tab.dataset.sceneAgent);
  const d = detailCache[selectedId];
  if (d) renderCase(d);
});
document.addEventListener('keydown', (event) => {
  if (!event.target.matches('[data-scene-agent]')) return;
  const tabs = [...document.querySelectorAll('[data-scene-agent]')];
  const index = tabs.indexOf(event.target);
  const next = {ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length}[event.key];
  if (next === undefined) return;
  event.preventDefault();
  sceneAgent = next;
  renderCase(detailCache[selectedId]);
  document.querySelector(`[data-scene-agent="${next}"]`)?.focus();
});
const loadDilemma = async () => {
  const id = selectedId;
  $('dl-case').setAttribute('aria-busy', 'true');
  try {
    detailCache[id] ||= await api(`/api/decision/dilemmas/${encodeURIComponent(id)}`);
    if (id !== selectedId) return;
    showError('');
    renderCase(detailCache[id]);
  } catch (error) { if (id === selectedId) { showError(error.message); $('dl-case').innerHTML = ''; } }
  finally { $('dl-case').setAttribute('aria-busy', 'false'); }
};

/* ---- evaluation ---- */
const outcomeHtml = (o) => `<span class="${o === 'aligned' ? 'dl-aligned' : o === 'opposed' ? 'dl-opposed' : 'dl-indiff'}">${escapeHtml(o)}</span>`;
const renderEval = () => {
  const features = Object.keys(catalog.features);
  const agents = catalog.agents;
  const cs = report.consistency.summary;
  const consistency = `<div class="dl-table-wrap"><table class="dl-table"><caption class="sr-only">Consistency per agent and feature</caption><thead><tr><th scope="col">Agent</th>${features.map((f) => `<th scope="col">${escapeHtml(featureLabel(f))}</th>`).join('')}<th scope="col">Violations</th></tr></thead><tbody>${agents.map((a) => {
    const s = cs[a.id];
    return `<tr><th scope="row">${escapeHtml(a.name)}</th>${features.map((f) => { const c = s.by_feature[f]; return `<td>${c ? `${escapeHtml(c.expected)}<span class="dl-cell-sub">changed ${c.changed}/${c.pairs}</span>` : '—'}</td>`; }).join('')}<td>${s.violations}<span class="dl-cell-sub">of ${s.pairs} pairs · ${s.ties_excluded} ties excluded</span></td></tr>`;
  }).join('')}</tbody></table></div>`;
  const audit = `<div class="dl-table-wrap"><table class="dl-table"><thead><tr><th scope="col">Agent</th><th scope="col">Audits passed</th></tr></thead><tbody>${agents.map((a) => { const s = report.explanations.summary[a.id]; return `<tr><th scope="row">${escapeHtml(a.name)}</th><td>${s.passed} / ${s.audited}</td></tr>`; }).join('')}</tbody></table></div>`;
  const hs = report.human.summary;
  const human = `<ul class="dl-prefs">${report.human.preferences.map((p) => `<li><strong>${escapeHtml(featureLabel(p.feature))}</strong>: spare ${escapeHtml(p.spare)} over ${escapeHtml(p.over)} <span class="dl-badge">${escapeHtml(p.strength)}</span></li>`).join('')}</ul>
    <div class="dl-table-wrap"><table class="dl-table"><caption class="sr-only">Agent outcomes against human preference directions</caption><thead><tr><th scope="col">Agent</th>${report.human.preferences.map((p) => `<th scope="col">${escapeHtml(featureLabel(p.feature))}</th>`).join('')}</tr></thead><tbody>${agents.map((a) => `<tr><th scope="row">${escapeHtml(a.name)}</th>${report.human.preferences.map((p) => `<td>${(hs[a.id]?.[p.feature] || []).map(outcomeHtml).join('<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  $('dl-eval').innerHTML = `<section class="dl-section"><h2>Consistency</h2><p class="dl-note">Each variant changes one feature. An agent is expected to react only to features in its rule; a violation is a changed decision (not a tie) for a feature it should ignore.</p>${consistency}</section>
    <section class="dl-section"><h2>Explanation audit</h2><p class="dl-note">Five mechanical checks per explanation across every dilemma.</p>${audit}</section>
    <section class="dl-section"><h2>Human comparison</h2><p class="dl-note">Source: ${escapeHtml(report.human.source)}. These are descriptive survey directions, not moral correctness. Each cell lists the outcome of every contrast for that feature.</p>${human}</section>
    <section class="dl-section"><h2>Agreement</h2><p>Unanimous on <strong>${report.agreement.unanimous}</strong> of <strong>${report.agreement.total}</strong> dilemmas.</p></section>`;
};
const loadReport = async () => {
  if (report) return;
  try { report = await api('/api/decision/report'); showError(''); renderEval(); }
  catch (error) { $('dl-eval').innerHTML = `<p class="dl-why">Could not load the evaluation report: ${escapeHtml(error.message)}</p>`; }
};

/* ---- LLM agents ---- */
const sourceLabel = (r) => (r.source === 'cache' ? 'Saved run' : r.source === 'recording' ? `Recorded on ${new Date(r.created_at).toLocaleDateString()}` : r.source === 'live' ? 'Live' : 'No source');
const spentHtml = (r) => (r === llmLast && r.requests_used != null ? `<span>${num(r.requests_used)} request${r.requests_used === 1 ? '' : 's'} used</span>` : '');
const num = (n) => (Number.isFinite(n) ? n : 0);
const runBlocker = () => {
  if (!llmStatus) return 'LLM status is not available.';
  if (llmRunning) return 'Running…';
  if (llmStatus.mode === 'offline') return 'Mode is offline: no live calls or recordings are available.';
  if (num(llmStatus.quota?.remaining) <= 0) return 'Daily quota is used up.';
  return '';
};
const statusHtml = () => {
  const s = llmStatus;
  if (!s) return `<p class="dl-why">${escapeHtml(llmMessage || UNAVAILABLE)}</p>`;
  const q = s.quota || {used: 0, limit: 0, remaining: 0};
  const pct = q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
  const cooldowns = Object.entries(s.cooldowns || {});
  return `<div class="dl-stats"><div class="dl-stat">Mode<strong>${escapeHtml(s.mode)}</strong></div><div class="dl-stat">Configured<strong>${s.configured ? 'yes' : 'no'}</strong></div>
    <div class="dl-stat">Daily quota<strong>${num(q.used)} / ${num(q.limit)}</strong>${num(q.remaining)} remaining</div>
    <div class="dl-stat">This minute<strong>${num(s.minute?.used)} / ${num(s.minute?.limit)}</strong></div>
    <div class="dl-stat">Recordings<strong>${num(s.recordings)}</strong></div>
    <div class="dl-stat">Cooldowns<strong>${cooldowns.length}</strong>${cooldowns.map(([m, until]) => `${escapeHtml(m)} until ${escapeHtml(new Date(until).toLocaleTimeString())}`).join('<br>')}</div></div>
    <div class="dl-meter ${q.remaining <= 0 ? 'full' : ''}" role="meter" aria-label="Daily quota used" aria-valuemin="0" aria-valuemax="${num(q.limit)}" aria-valuenow="${num(q.used)}"><span style="width:${pct}%"></span></div>`;
};
const resultHtml = (r) => {
  const meta = `<div class="dl-result-meta">${r.status === 'ok' ? `<span class="dl-badge teal">${escapeHtml(sourceLabel(r))}</span>` : ''}${r.model_id ? `<span>${escapeHtml(r.model_id)}</span>` : ''}${r.duration_ms != null ? `<span>${num(r.duration_ms)} ms</span>` : ''}${spentHtml(r)}<span>${new Date(r.created_at).toLocaleString()}</span></div>${r.fallback ? `<div class="dl-alert">Live run failed (${escapeHtml(r.fallback.message)}), so a recording is shown instead.</div>` : ''}`;
  if (r.status !== 'ok') {
    const e = r.error || {};
    return `<div class="dl-card dl-result">${meta}<div class="dl-alert">${escapeHtml(e.message || 'The run failed.')}${e.retry_after != null ? ` Try again in ${num(e.retry_after)} s.` : ''}</div></div>`;
  }
  return `<div class="dl-card dl-result">${meta}<div class="dl-agents">${(r.answers || []).map((a) => `<article class="dl-agent"><h3>${escapeHtml(agentName(a.agent))}</h3>
    <div class="dl-choice">LLM: ${escapeHtml(CHOICE[a.choice] || a.choice)} <span class="dl-badge ${a.matches_reference ? 'good' : 'bad'}">${a.matches_reference ? 'matches reference' : 'differs from reference'}</span></div>
    <div class="dl-scores">Reference: ${escapeHtml(CHOICE[a.reference_choice] || a.reference_choice)}${a.reference_tie ? ' (tie → default)' : ''}</div>
    <p class="dl-expl">${escapeHtml(a.explanation)}</p>${auditHtml(a.audit)}</article>`).join('')}</div></div>`;
};
const renderLlm = () => {
  const d = byId(selectedId);
  const blocker = runBlocker();
  const last = llmLast && llmLast.dilemma_id === selectedId ? llmLast : null;
  const rest = (llmResults || []).filter((r) => !(last && r.created_at === last.created_at && r.model_id === last.model_id));
  $('dl-llm').innerHTML = `<section class="dl-section"><h2>LLM service</h2>${statusHtml()}
    <p class="dl-note">Free OpenRouter models allow roughly 50 requests per day and 20 per minute. One run is one request for all four agents.</p></section>
    <section class="dl-section"><h2>Run on the selected dilemma</h2><p>${escapeHtml(d?.title || '')}${d?.base ? ` <span class="dl-badge teal">${escapeHtml(d.change)}</span>` : ''}</p>
    <div class="dl-run"><button class="button dl-run-btn" id="dl-run" ${blocker ? 'disabled' : ''}>Run LLM agents on this dilemma</button><label><input type="checkbox" id="dl-repeat" ${llmRepeat ? 'checked' : ''}> Repeat (uses quota)</label></div>
    <div class="dl-why" id="dl-why" aria-live="polite">${escapeHtml(blocker && !llmRunning ? blocker : llmRunning ? 'Running…' : '')}${llmMessage && llmStatus ? ` ${escapeHtml(llmMessage)}` : ''}</div></section>
    <section class="dl-section"><h2>Results</h2>${last ? resultHtml(last) : ''}${llmResults === null ? '<p class="muted">No results loaded.</p>' : rest.length ? rest.map(resultHtml).join('') : last ? '' : '<p class="muted">No LLM results yet for this dilemma.</p>'}</section>`;
};
const refreshStatus = async () => {
  try { llmStatus = await api('/api/decision/llm/status'); } catch { llmStatus = null; llmMessage = UNAVAILABLE; }
};
const refreshResults = async () => {
  const id = selectedId;
  try {
    const data = await api(`/api/decision/llm/results?dilemma_id=${encodeURIComponent(id)}`);
    if (id !== selectedId) return;
    llmResults = data.results || [];
  } catch { if (id !== selectedId) return; llmResults = []; llmMessage = UNAVAILABLE; }
  renderLlm();
};
const loadLlm = async () => {
  if (llmLoaded) { renderLlm(); return; }
  llmLoaded = true;
  llmMessage = '';
  try { llmStatus = await api('/api/decision/llm/status'); }
  catch { llmStatus = null; llmMessage = UNAVAILABLE; renderLlm(); return; }
  renderLlm();
  await refreshResults();
};
const runLlm = async () => {
  if (runBlocker()) return;
  const repeat = llmRepeat = $('dl-repeat').checked;
  llmRunning = true; llmMessage = '';
  renderLlm();
  try {
    const result = await api('/api/decision/llm/run', 'POST', {dilemma_id: selectedId, repeat});
    llmLast = result.dilemma_id === selectedId ? result : null;
  } catch { llmMessage = UNAVAILABLE; }
  llmRunning = false; llmRepeat = false;
  await refreshStatus();
  await refreshResults();
  $('dl-run')?.focus();
};

/* ---- boot ---- */
const init = async () => {
  initTabs();
  document.addEventListener('click', (event) => {
    const item = event.target.closest('[data-id]');
    if (item) select(item.dataset.id);
    else if (event.target.closest('#dl-run')) runLlm();
  });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'dl-repeat') llmRepeat = event.target.checked;
  });
  window.addEventListener('hashchange', () => { const id = hashId(); if (catalog && id && id !== selectedId) select(id, false); });
  try { catalog = await api('/api/decision/catalog'); }
  catch (error) { showError(`Could not load the Decision Lab: ${error.message}`); $('dl-case').innerHTML = ''; return; }
  select(hashId(), false);
};
init();
