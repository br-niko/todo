/**
 * E-Ink Todoist App
 * - Tipografia IBM Plex Sans com linhas finas e visual balanceado
 * - Sincroniza diretamente com a Unified API v1 do Todoist (https://api.todoist.com/api/v1)
 * - Usa #label na digitação, e exibe o texto limpo da label (sem o #)
 * - Suporta subtarefas (parent_id) com botão e modal dedicado
 * - Suporta datas personalizadas (seletor de calendário ou @25/12, @hoje, @amanha)
 * - Edição inline com ícones SVG nítidos e proporcionais
 * - Checkbox com preenchimento preto anti-ghosting e contagem regressiva
 */

const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';

const ICONS = {
  EDIT: `<svg class="icon-svg icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  CLOSE: `<svg class="icon-svg icon-sm" viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  CHECK: `<svg class="icon-svg icon-sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`,
  SUBTASK: `<svg class="icon-svg icon-sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>`
};

const STORAGE_KEYS = {
  TOKEN: 'eink_todoist_token',
  TASKS: 'eink_todoist_tasks_cache',
  LABELS: 'eink_todoist_labels_cache',
  LAST_SYNC: 'eink_todoist_last_sync',
  ACTIVE_FILTER: 'eink_todoist_active_filter'
};

const state = {
  token: localStorage.getItem(STORAGE_KEYS.TOKEN) || '',
  tasks: JSON.parse(localStorage.getItem(STORAGE_KEYS.TASKS) || '[]'),
  labels: JSON.parse(localStorage.getItem(STORAGE_KEYS.LABELS) || '[]'),
  activeFilter: localStorage.getItem(STORAGE_KEYS.ACTIVE_FILTER) || 'all', // 'all', 'today' ou 'label:<name>'
  isSyncing: false,
  pendingCompletions: new Map(), // taskId -> intervalId
  editingTaskId: null,
  activeParentTask: null // Tarefa pai aberta no modal de subtarefas
};

// Elementos DOM
const els = {
  viewTitle: document.getElementById('current-view-title'),
  syncStatus: document.getElementById('sync-status'),
  btnToggleAdd: document.getElementById('btn-toggle-add'),
  btnSync: document.getElementById('btn-sync'),
  btnSettings: document.getElementById('btn-settings'),
  projectsBar: document.getElementById('projects-bar'),
  projectChips: document.getElementById('project-chips'),
  addTaskSection: document.getElementById('add-task-section'),
  addTaskForm: document.getElementById('add-task-form'),
  taskInput: document.getElementById('task-input'),
  taskDescInput: document.getElementById('task-desc-input'),
  btnCancelAdd: document.getElementById('btn-cancel-add'),
  taskDueSelect: document.getElementById('task-due-select'),
  taskCustomDate: document.getElementById('task-custom-date'),
  taskPrioritySelect: document.getElementById('task-priority-select'),
  alertBox: document.getElementById('alert-box'),
  tasksList: document.getElementById('tasks-list'),
  emptyState: document.getElementById('empty-state'),
  tasksCount: document.getElementById('tasks-count'),
  footerTag: document.getElementById('footer-tag'),
  lastSyncTime: document.getElementById('sync-status'),
  // Modal de Subtarefas
  subtasksModal: document.getElementById('subtasks-modal'),
  subtasksParentName: document.getElementById('subtasks-parent-name'),
  subtasksList: document.getElementById('subtasks-list'),
  subtasksEmpty: document.getElementById('subtasks-empty'),
  addSubtaskForm: document.getElementById('add-subtask-form'),
  subtaskInput: document.getElementById('subtask-input'),
  subtaskDescInput: document.getElementById('subtask-desc-input'),
  btnCloseSubtasks: document.getElementById('btn-close-subtasks'),
  btnDoneSubtasks: document.getElementById('btn-done-subtasks'),
  // Modal de Configurações
  settingsModal: document.getElementById('settings-modal'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  apiTokenInput: document.getElementById('api-token-input'),
  toggleShowToken: document.getElementById('toggle-show-token'),
  newProjectInput: document.getElementById('new-project-input'),
  btnCreateProject: document.getElementById('btn-create-project'),
  btnClearCache: document.getElementById('btn-clear-cache'),
  btnSaveSettings: document.getElementById('btn-save-settings')
};

/* ==========================================================================
   INICIALIZAÇÃO
   ========================================================================== */
function init() {
  renderAll();
  bindEvents();

  const lastSync = localStorage.getItem(STORAGE_KEYS.LAST_SYNC);
  if (lastSync) {
    updateSyncStatus(`sincronizado às ${lastSync}`, true);
  } else {
    updateSyncStatus('nunca sincronizado', false);
  }

  if (state.token) {
    syncWithTodoist();
  } else {
    updateSyncStatus('modo local', false);
    showAlert(
      'Você está no Modo Local. Clique no ícone de engrenagem no topo para colar seu Token do Todoist.'
    );
  }
}

function saveCache() {
  localStorage.setItem(STORAGE_KEYS.TASKS, JSON.stringify(state.tasks));
  localStorage.setItem(STORAGE_KEYS.LABELS, JSON.stringify(state.labels));
  localStorage.setItem(STORAGE_KEYS.ACTIVE_FILTER, state.activeFilter);
}

/* ==========================================================================
   COMUNICAÇÃO COM A API DO TODOIST (UNIFIED API v1)
   ========================================================================== */
async function todoistFetch(endpoint, options = {}) {
  if (!state.token) {
    throw new Error('Token da API não configurado.');
  }

  const headers = {
    Authorization: `Bearer ${state.token}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(`${TODOIST_API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Token inválido ou sem permissão (Erro 401/403). Verifique nas configurações.');
    }
    throw new Error(`Erro na API do Todoist (${response.status})`);
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function todoistFetchAll(endpoint) {
  let items = [];
  let cursor = null;

  do {
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = cursor ? `${endpoint}${sep}cursor=${encodeURIComponent(cursor)}` : endpoint;
    const data = await todoistFetch(url);

    if (Array.isArray(data)) {
      items = items.concat(data);
      cursor = null;
    } else if (data && Array.isArray(data.results)) {
      items = items.concat(data.results);
      cursor = data.next_cursor || null;
    } else {
      cursor = null;
    }
  } while (cursor);

  return items;
}

async function syncWithTodoist() {
  if (!state.token) {
    openSettingsModal();
    return;
  }
  if (state.isSyncing) return;

  state.isSyncing = true;
  updateSyncStatus('sincronizando...', false);
  hideAlert();

  try {
    const [tasks, labels] = await Promise.all([
      todoistFetchAll('/tasks'),
      todoistFetchAll('/labels').catch(() => [])
    ]);

    state.tasks = tasks.filter(t => !t.checked && !t.is_deleted);
    state.labels = labels.filter(l => !l.is_deleted);

    const nowStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    localStorage.setItem(STORAGE_KEYS.LAST_SYNC, nowStr);
    updateSyncStatus(`sincronizado às ${nowStr}`, true);

    saveCache();
    renderAll();
    if (state.activeParentTask) {
      renderSubtasksModalList();
    }
  } catch (err) {
    updateSyncStatus('erro no sync', false);
    showAlert(err.message);
  } finally {
    state.isSyncing = false;
  }
}

/* ==========================================================================
   PARSER DE SINTAXE RÁPIDA (#label, datas e prioridades p1..p4)
   ========================================================================== */
function normalizeStr(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '');
}

function parseTaskInput(rawText, defaultPriority = null, isEditMode = false) {
  let content = rawText.trim();
  const extractedLabels = new Set();

  let priority = defaultPriority !== null ? defaultPriority : (parseInt(els.taskPrioritySelect.value, 10) || 1);
  let hasPriorityOverride = false;

  let dueDateIso = null;
  let dueString = '';
  let hasDueOverride = false;

  if (!isEditMode) {
    const selVal = els.taskDueSelect.value;
    if (selVal === 'custom' && els.taskCustomDate.value) {
      dueDateIso = els.taskCustomDate.value;
    } else if (selVal && selVal !== 'custom') {
      dueString = selVal;
    }
  }

  const hashRegex = /(?:^|\s)#([^\s#@]+)/g;
  let hashMatch;
  const hashesFound = [];
  while ((hashMatch = hashRegex.exec(content)) !== null) {
    hashesFound.push({ full: hashMatch[0], name: hashMatch[1].trim() });
  }

  hashesFound.forEach(h => {
    const norm = normalizeStr(h.name);
    const knownLabel = state.labels.find(l => normalizeStr(l.name) === norm);
    extractedLabels.add(knownLabel ? knownLabel.name : h.name);
    content = content.replace(h.full, ' ').trim();
  });

  const atRegex = /(?:^|\s)@([^\s#@]+)/g;
  let atMatch;
  const atsFound = [];
  while ((atMatch = atRegex.exec(content)) !== null) {
    atsFound.push({ full: atMatch[0], token: atMatch[1].trim() });
  }

  atsFound.forEach(a => {
    const lower = a.token.toLowerCase();
    if (lower === 'hoje' || lower === 'today') {
      dueDateIso = getTodayIso();
      dueString = '';
      hasDueOverride = true;
    } else if (lower.startsWith('amanh') || lower === 'tomorrow') {
      dueDateIso = getOffsetDateIso(1);
      dueString = '';
      hasDueOverride = true;
    } else if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(lower)) {
      const parsed = parseBrDateToIso(lower);
      if (parsed) {
        dueDateIso = parsed;
        dueString = '';
        hasDueOverride = true;
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) {
      dueDateIso = lower;
      dueString = '';
      hasDueOverride = true;
    } else {
      const knownLabel = state.labels.find(l => normalizeStr(l.name) === normalizeStr(a.token));
      extractedLabels.add(knownLabel ? knownLabel.name : a.token);
    }
    content = content.replace(a.full, ' ').trim();
  });

  const prioRegex = /(?:^|\s)(p[1-4])(?=\s|$)/i;
  const prioMatch = content.match(prioRegex);
  if (prioMatch) {
    const pTag = prioMatch[1].toLowerCase();
    const mapPrio = { p1: 4, p2: 3, p3: 2, p4: 1 };
    priority = mapPrio[pTag] || priority;
    hasPriorityOverride = true;
    content = content.replace(prioMatch[0], ' ').trim();
  }

  if (!isEditMode && extractedLabels.size === 0 && state.activeFilter.startsWith('label:')) {
    const activeLabelName = state.activeFilter.slice('label:'.length);
    if (activeLabelName) extractedLabels.add(activeLabelName);
  }

  if (!dueDateIso && !dueString && !isEditMode && state.activeFilter === 'today') {
    dueDateIso = getTodayIso();
  }

  return {
    content: content.replace(/\s+/g, ' ').trim() || rawText.trim(),
    labels: Array.from(extractedLabels),
    priority,
    hasPriorityOverride,
    dueDateIso,
    dueString,
    hasDueOverride
  };
}

function parseBrDateToIso(brStr) {
  const parts = brStr.split('/');
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const now = new Date();
  let year = parts[2] ? parseInt(parts[2], 10) : now.getFullYear();
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* ==========================================================================
   OPERAÇÕES DE TAREFAS, LABELS E SUBTAREFAS
   ========================================================================== */
async function createLabel(name) {
  const cleanName = name.trim().replace(/^[#@]/, '');
  if (!cleanName) return null;

  if (state.token) {
    const newLbl = await todoistFetch('/labels', {
      method: 'POST',
      body: JSON.stringify({ name: cleanName })
    });
    state.labels.push(newLbl);
    saveCache();
    renderAll();
    return newLbl;
  } else {
    const localLbl = {
      id: 'local-lbl-' + Date.now(),
      name: cleanName
    };
    state.labels.push(localLbl);
    saveCache();
    renderAll();
    return localLbl;
  }
}

async function handleAddTask(e) {
  e.preventDefault();
  const rawText = els.taskInput.value.trim();
  if (!rawText) return;

  const description = els.taskDescInput ? els.taskDescInput.value.trim() : '';

  const {
    content,
    labels,
    priority,
    dueDateIso,
    dueString
  } = parseTaskInput(rawText, null, false);

  els.taskInput.disabled = true;
  if (els.taskDescInput) els.taskDescInput.disabled = true;

  try {
    if (state.token) {
      const payload = {
        content,
        priority
      };
      if (description) {
        payload.description = description;
      }
      if (labels && labels.length > 0) {
        payload.labels = labels;
      }
      if (dueDateIso) {
        payload.due_date = dueDateIso;
      } else if (dueString) {
        payload.due_string = dueString;
        payload.due_lang = 'pt';
      }

      const createdTask = await todoistFetch('/tasks', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      state.tasks.push(createdTask);
    } else {
      const todayIso = getTodayIso();
      const tomorrowIso = getOffsetDateIso(1);
      let dueObj = null;
      if (dueDateIso) dueObj = { date: dueDateIso, string: dueDateIso };
      else if (dueString === 'today') dueObj = { date: todayIso, string: 'Hoje' };
      else if (dueString === 'tomorrow') dueObj = { date: tomorrowIso, string: 'Amanhã' };
      else if (dueString) dueObj = { date: getOffsetDateIso(7), string: dueString };

      state.tasks.push({
        id: 'local-task-' + Date.now(),
        content,
        description: description || '',
        labels: labels || [],
        priority,
        due: dueObj,
        added_at: new Date().toISOString()
      });
    }

    els.taskInput.value = '';
    if (els.taskDescInput) els.taskDescInput.value = '';
    els.taskDueSelect.value = '';
    els.taskCustomDate.value = '';
    els.taskCustomDate.classList.add('hidden');
    els.taskPrioritySelect.value = '1';
    closeAddTaskBox();
    saveCache();
    renderAll();
  } catch (err) {
    showAlert(`Não foi possível criar a tarefa: ${err.message}`);
  } finally {
    els.taskInput.disabled = false;
    if (els.taskDescInput) els.taskDescInput.disabled = false;
  }
}

/**
 * Adiciona uma subtarefa vinculada à tarefa pai aberta no modal
 */
async function handleAddSubtask(e) {
  e.preventDefault();
  if (!state.activeParentTask) return;

  const rawText = els.subtaskInput.value.trim();
  if (!rawText) return;

  const subDesc = els.subtaskDescInput ? els.subtaskDescInput.value.trim() : '';
  const parentId = String(state.activeParentTask.id);
  els.subtaskInput.disabled = true;
  if (els.subtaskDescInput) els.subtaskDescInput.disabled = true;

  try {
    if (state.token && !parentId.startsWith('local-')) {
      const payload = {
        content: rawText,
        parent_id: parentId
      };
      if (subDesc) {
        payload.description = subDesc;
      }

      const createdSubtask = await todoistFetch('/tasks', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      state.tasks.push(createdSubtask);
    } else {
      state.tasks.push({
        id: 'local-task-' + Date.now(),
        content: rawText,
        description: subDesc || '',
        parent_id: parentId,
        priority: 1,
        added_at: new Date().toISOString()
      });
    }

    els.subtaskInput.value = '';
    if (els.subtaskDescInput) els.subtaskDescInput.value = '';
    saveCache();
    renderSubtasksModalList();
    renderTasks();
  } catch (err) {
    showAlert(`Não foi possível criar a subtarefa: ${err.message}`);
  } finally {
    els.subtaskInput.disabled = false;
    if (els.subtaskDescInput) els.subtaskDescInput.disabled = false;
    els.subtaskInput.focus();
  }
}

function openSubtasksModal(task) {
  state.activeParentTask = task;
  els.subtasksParentName.textContent = `Tarefa: "${task.content}"`;
  renderSubtasksModalList();
  els.subtasksModal.classList.remove('hidden');
  setTimeout(() => {
    els.subtaskInput.focus();
  }, 40);
}

function closeSubtasksModal() {
  state.activeParentTask = null;
  els.subtasksModal.classList.add('hidden');
  renderAll();
}

function renderSubtasksModalList() {
  if (!state.activeParentTask) return;

  const parentId = String(state.activeParentTask.id);
  const subtasks = state.tasks.filter(t => String(t.parent_id) === parentId);

  els.subtasksList.innerHTML = '';

  if (subtasks.length === 0) {
    els.subtasksEmpty.classList.remove('hidden');
  } else {
    els.subtasksEmpty.classList.add('hidden');
  }

  subtasks.forEach(sub => {
    const li = document.createElement('li');
    li.className = 'task-item';

    const left = document.createElement('div');
    left.className = 'task-left';

    const checkboxWrap = document.createElement('div');
    checkboxWrap.className = 'task-checkbox-wrap';

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = `task-checkbox priority-${sub.priority || 1}`;
    checkbox.setAttribute('aria-label', 'Concluir subtarefa');

    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'countdown-dots hidden';

    checkbox.addEventListener('click', () =>
      toggleCompleteTaskWithCountdown(sub, li, checkbox, dotsContainer)
    );

    checkboxWrap.appendChild(checkbox);
    checkboxWrap.appendChild(dotsContainer);

    const contentWrap = document.createElement('div');
    contentWrap.className = 'task-content-wrap';

    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = sub.content;
    contentWrap.appendChild(title);

    if (sub.description && sub.description.trim()) {
      const subDesc = document.createElement('div');
      subDesc.className = 'task-desc';
      subDesc.innerHTML = renderMarkdown(sub.description);
      contentWrap.appendChild(subDesc);
    }

    left.appendChild(checkboxWrap);
    left.appendChild(contentWrap);

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-task-action';
    delBtn.title = 'Excluir subtarefa';
    delBtn.setAttribute('aria-label', 'Excluir subtarefa');
    delBtn.innerHTML = ICONS.CLOSE;
    delBtn.addEventListener('click', () => deleteTask(sub.id));

    actions.appendChild(delBtn);

    li.appendChild(left);
    li.appendChild(actions);
    els.subtasksList.appendChild(li);
  });
}

async function saveEditedTask(task, newRawText, newDateValue, newDescription = '') {
  const trimmed = newRawText.trim();
  if (!trimmed) {
    state.editingTaskId = null;
    renderAll();
    return;
  }

  const {
    content,
    labels,
    priority,
    hasPriorityOverride,
    dueDateIso,
    dueString,
    hasDueOverride
  } = parseTaskInput(trimmed, task.priority || 1, true);

  const finalDueDate = newDateValue || dueDateIso || null;
  const previousDueDate = task.due?.date ? task.due.date.substring(0, 10) : '';
  const dateChangedByPicker = newDateValue !== previousDueDate;
  const finalDesc = (newDescription || '').trim();

  try {
    if (state.token && !String(task.id).startsWith('local-')) {
      const payload = {
        content,
        labels,
        description: finalDesc
      };
      if (hasPriorityOverride) {
        payload.priority = priority;
      }
      if (finalDueDate && (dateChangedByPicker || hasDueOverride)) {
        payload.due_date = finalDueDate;
      } else if (!newDateValue && dateChangedByPicker && !hasDueOverride) {
        payload.due_string = 'no date';
      } else if (hasDueOverride && dueString) {
        payload.due_string = dueString;
        payload.due_lang = 'pt';
      }

      const updated = await todoistFetch(`/tasks/${task.id}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      const idx = state.tasks.findIndex(t => String(t.id) === String(task.id));
      if (idx !== -1) {
        state.tasks[idx] = { ...state.tasks[idx], ...updated };
      }
    } else {
      const idx = state.tasks.findIndex(t => String(t.id) === String(task.id));
      if (idx !== -1) {
        state.tasks[idx].content = content;
        state.tasks[idx].description = finalDesc;
        state.tasks[idx].labels = labels;
        if (hasPriorityOverride) state.tasks[idx].priority = priority;
        if (finalDueDate) {
          state.tasks[idx].due = { date: finalDueDate, string: finalDueDate };
        } else if (dateChangedByPicker && !newDateValue) {
          state.tasks[idx].due = null;
        }
      }
    }

    state.editingTaskId = null;
    saveCache();
    renderAll();
  } catch (err) {
    showAlert(`Erro ao editar tarefa: ${err.message}`);
  }
}

function toggleCompleteTaskWithCountdown(task, liElement, checkboxBtn, dotsContainer) {
  const key = String(task.id);

  if (state.pendingCompletions.has(key)) {
    clearInterval(state.pendingCompletions.get(key));
    state.pendingCompletions.delete(key);
    liElement.classList.remove('completing');
    checkboxBtn.textContent = task.priority === 4 ? '!' : '';
    dotsContainer.innerHTML = '';
    dotsContainer.classList.add('hidden');
    return;
  }

  liElement.classList.add('completing');
  checkboxBtn.textContent = '✓';
  dotsContainer.classList.remove('hidden');

  let remainingDots = 3;
  renderVerticalDots(dotsContainer, remainingDots);

  const intervalId = setInterval(async () => {
    remainingDots -= 1;

    if (remainingDots > 0) {
      renderVerticalDots(dotsContainer, remainingDots);
    } else {
      clearInterval(intervalId);
      state.pendingCompletions.delete(key);
      dotsContainer.innerHTML = '';

      try {
        if (state.token && !key.startsWith('local-')) {
          await todoistFetch(`/tasks/${task.id}/close`, { method: 'POST' });
        }
        state.tasks = state.tasks.filter(t => String(t.id) !== key && String(t.parent_id) !== key);
        saveCache();
        renderAll();
        if (state.activeParentTask) {
          renderSubtasksModalList();
        }
      } catch (err) {
        liElement.classList.remove('completing');
        checkboxBtn.textContent = task.priority === 4 ? '!' : '';
        dotsContainer.classList.add('hidden');
        showAlert(`Erro ao concluir tarefa: ${err.message}`);
      }
    }
  }, 650);

  state.pendingCompletions.set(key, intervalId);
}

function renderVerticalDots(container, count) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('span');
    dot.className = 'countdown-dot';
    container.appendChild(dot);
  }
}

async function deleteTask(taskId) {
  const key = String(taskId);
  const taskToDel = state.tasks.find(t => String(t.id) === key);
  const taskName = taskToDel ? `"${taskToDel.content}"` : 'esta tarefa';
  if (!confirm(`Deseja realmente excluir ${taskName}?`)) {
    return;
  }

  if (state.pendingCompletions.has(key)) {
    clearInterval(state.pendingCompletions.get(key));
    state.pendingCompletions.delete(key);
  }

  try {
    if (state.token && !key.startsWith('local-')) {
      await todoistFetch(`/tasks/${taskId}`, { method: 'DELETE' });
    }
    state.tasks = state.tasks.filter(t => String(t.id) !== key && String(t.parent_id) !== key);
    saveCache();
    renderAll();
    if (state.activeParentTask) {
      renderSubtasksModalList();
    }
  } catch (err) {
    showAlert(`Erro ao excluir tarefa: ${err.message}`);
  }
}

/* ==========================================================================
   FILTRAGEM E RENDERIZAÇÃO
   ========================================================================== */
function getTodayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getOffsetDateIso(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isDueTodayOrOverdue(task) {
  if (!task.due || !task.due.date) return false;
  const taskDate = task.due.date.substring(0, 10);
  return taskDate <= getTodayIso();
}

function isOverdue(task) {
  if (!task.due || !task.due.date) return false;
  const taskDate = task.due.date.substring(0, 10);
  return taskDate < getTodayIso();
}

function getFilteredTasks() {
  let list = state.tasks.filter(t => !t.parent_id);

  if (state.activeFilter === 'today') {
    list = list.filter(isDueTodayOrOverdue);
  } else if (state.activeFilter.startsWith('label:')) {
    const labelName = state.activeFilter.slice('label:'.length);
    list = list.filter(t => Array.isArray(t.labels) && t.labels.includes(labelName));
  }

  list.sort((a, b) => {
    const prioDiff = (b.priority || 1) - (a.priority || 1);
    if (prioDiff !== 0) return prioDiff;

    const dateA = a.due?.date ? a.due.date.substring(0, 10) : '9999-99-99';
    const dateB = b.due?.date ? b.due.date.substring(0, 10) : '9999-99-99';
    return dateA.localeCompare(dateB);
  });

  return list;
}

function getActiveLabelsWithCounts() {
  const counts = new Map();
  state.tasks.filter(t => !t.parent_id).forEach(t => {
    if (Array.isArray(t.labels)) {
      t.labels.forEach(lbl => {
        counts.set(lbl, (counts.get(lbl) || 0) + 1);
      });
    }
  });
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
}

function renderAll() {
  if (state.activeFilter !== 'all') {
    if (
      state.activeFilter !== 'today' &&
      !state.activeFilter.startsWith('label:')
    ) {
      state.activeFilter = 'all';
    } else if (getFilteredTasks().length === 0) {
      state.activeFilter = 'all';
    }
  }

  renderLabelsNav();
  renderQuickLabelChips();
  renderTasks();
}

function renderLabelsNav() {
  els.projectsBar.innerHTML = '';

  const rootTasks = state.tasks.filter(t => !t.parent_id);
  const totalCount = rootTasks.length;
  const todayCount = rootTasks.filter(isDueTodayOrOverdue).length;

  els.projectsBar.appendChild(
    createFilterTab('all', 'Todas', totalCount)
  );

  if (todayCount > 0) {
    els.projectsBar.appendChild(
      createFilterTab('today', 'Hoje', todayCount)
    );
  }

  // Mostra as abas no topo apenas com o nome da tag (sem o #)
  const activeLabels = getActiveLabelsWithCounts();
  activeLabels.forEach(lbl => {
    els.projectsBar.appendChild(
      createFilterTab(`label:${lbl.name}`, lbl.name, lbl.count)
    );
  });

  // No topo, sempre manter "tarefas"
  if (els.viewTitle) {
    els.viewTitle.textContent = 'tarefas';
  }
}

function createFilterTab(filterId, labelText, count) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const activeClass = String(state.activeFilter) === String(filterId) ? 'active' : '';
  btn.className = `project-tab ${activeClass}`.trim();
  btn.innerHTML = `<span>${escapeHtml(labelText)}</span><span class="project-count">${count}</span>`;
  btn.addEventListener('click', () => {
    state.activeFilter = String(filterId);
    saveCache();
    renderAll();
  });
  return btn;
}

function renderQuickLabelChips() {
  els.projectChips.innerHTML = '';

  const activeLabels = getActiveLabelsWithCounts();

  activeLabels.forEach(lbl => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    const tagText = `#${lbl.name.replace(/\s+/g, '')}`;
    // No chip exibe apenas o texto da tag (sem o #), mas ao clicar insere com o #
    chip.textContent = lbl.name;
    chip.title = `Inserir ${tagText} na tarefa`;
    chip.addEventListener('click', () => insertLabelTagInInput(tagText));
    els.projectChips.appendChild(chip);
  });
}

function insertLabelTagInInput(tag) {
  openAddTaskBox();
  const current = els.taskInput.value.trim();
  if (!current.includes(tag)) {
    els.taskInput.value = current ? `${current} ${tag} ` : `${tag} `;
  }
  els.taskInput.focus();
}

function openAddTaskBox() {
  els.addTaskSection.classList.remove('hidden');
  els.taskInput.focus();
}

function closeAddTaskBox() {
  els.addTaskSection.classList.add('hidden');
  els.taskInput.value = '';
  if (els.taskDescInput) els.taskDescInput.value = '';
}

function renderMarkdown(rawText) {
  if (!rawText || !rawText.trim()) return '';

  let text = String(rawText)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 1. Extrair blocos de código ``` ... ```
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="md-code-block"><code>${code.trim()}</code></pre>`);
    return `@@CODEBLOCK${idx}@@`;
  });

  // 2. Extrair código inline `...`
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="md-inline-code">${code}</code>`);
    return `@@INLINECODE${idx}@@`;
  });

  // 3. Cabeçalhos (# H1 a ###### H6)
  text = text.replace(/^######\s+(.+)$/gm, '<h6 class="md-h">$1</h6>');
  text = text.replace(/^#####\s+(.+)$/gm, '<h5 class="md-h">$1</h5>');
  text = text.replace(/^####\s+(.+)$/gm, '<h4 class="md-h">$1</h4>');
  text = text.replace(/^###\s+(.+)$/gm, '<h3 class="md-h">$1</h3>');
  text = text.replace(/^##\s+(.+)$/gm, '<h2 class="md-h">$1</h2>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1 class="md-h">$1</h1>');

  // 4. Citações e linhas horizontais
  text = text.replace(/^>\s+(.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');
  text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="md-hr">');

  // 5. Checklists (- [ ] ou - [x])
  text = text.replace(/^[\*\-]\s+\[([ xX])\]\s+(.+)$/gm, (m, check, item) => {
    const isChecked = check.toLowerCase() === 'x';
    return `<div class="md-checklist-item"><span class="md-checkbox">${isChecked ? '☑' : '☐'}</span> <span>${item}</span></div>`;
  });

  // 6. Listas não-ordenadas (* ou -)
  text = text.replace(/(?:^[\*\-]\s+(.+)$\n?)+/gm, match => {
    const lines = match.trim().split('\n');
    const items = lines.map(l => l.replace(/^[\*\-]\s+/, '').trim());
    return `<ul class="md-ul">${items.map(it => `<li>${it}</li>`).join('')}</ul>\n`;
  });

  // 7. Listas numeradas (1. 2. etc.)
  text = text.replace(/(?:^\d+\.\s+(.+)$\n?)+/gm, match => {
    const lines = match.trim().split('\n');
    const items = lines.map(l => l.replace(/^\d+\.\s+/, '').trim());
    return `<ol class="md-ol">${items.map(it => `<li>${it}</li>`).join('')}</ol>\n`;
  });

  // 8. Links [texto](url)
  const links = [];
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
    const cleanUrl = url.trim();
    if (/^(https?:\/\/|mailto:|\/)/i.test(cleanUrl)) {
      const idx = links.length;
      links.push(`<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`);
      return `@@LINK${idx}@@`;
    }
    return label;
  });

  // Links automáticos (https://...)
  text = text.replace(/(^|[^\w"\'\/\=])(https?:\/\/[^\s<]+)/g, (match, prefix, url) => {
    const idx = links.length;
    links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${url}</a>`);
    return `${prefix}@@LINK${idx}@@`;
  });

  // 9. Negrito, itálico, tachado
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^\*])\*([^*]+)\*([^\*]|$)/g, '$1<em>$2</em>$3');
  text = text.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 10. Restaurar links, inline code e code blocks
  text = text.replace(/@@LINK(\d+)@@/g, (match, idx) => links[idx] || '');
  text = text.replace(/@@INLINECODE(\d+)@@/g, (match, idx) => inlineCodes[idx] || '');
  text = text.replace(/@@CODEBLOCK(\d+)@@/g, (match, idx) => codeBlocks[idx] || '');

  // 11. Quebras de linha fora de tags de bloco
  const blockTags = /(<\/?(?:ul|ol|li|pre|code|blockquote|h[1-6]|hr|div)[^>]*>)/gi;
  const tokens = text.split(blockTags);
  let result = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (blockTags.test(token)) {
      result += token;
    } else {
      result += token.replace(/\n/g, '<br>');
    }
  }

  return result.trim().replace(/(?:<br>\s*)+$/g, '');
}

function renderTasks() {
  const filtered = getFilteredTasks();
  els.tasksList.innerHTML = '';

  if (filtered.length === 0) {
    els.emptyState.classList.remove('hidden');
  } else {
    els.emptyState.classList.add('hidden');
  }

  filtered.forEach(task => {
    const isEditing = String(state.editingTaskId) === String(task.id);
    const subtasks = state.tasks.filter(t => String(t.parent_id) === String(task.id));

    const li = document.createElement('li');
    li.className = 'task-item';

    const left = document.createElement('div');
    left.className = 'task-left';

    const checkboxWrap = document.createElement('div');
    checkboxWrap.className = 'task-checkbox-wrap';

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = `task-checkbox priority-${task.priority || 1}`;
    checkbox.setAttribute('aria-label', 'Concluir tarefa');
    checkbox.textContent = task.priority === 4 ? '!' : '';

    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'countdown-dots hidden';

    checkbox.addEventListener('click', () =>
      toggleCompleteTaskWithCountdown(task, li, checkbox, dotsContainer)
    );

    checkboxWrap.appendChild(checkbox);
    checkboxWrap.appendChild(dotsContainer);

    const contentWrap = document.createElement('div');
    contentWrap.className = 'task-content-wrap';

    const taskLabels = Array.isArray(task.labels) ? task.labels : [];

    if (isEditing) {
      li.classList.add('is-editing');

      const editForm = document.createElement('form');
      editForm.className = 'task-edit-form';
      editForm.autocomplete = 'off';

      const editInput = document.createElement('input');
      editInput.type = 'text';
      editInput.className = 'task-edit-input';
      editInput.placeholder = 'Nome da tarefa...';

      const currentLabelsSuffix = taskLabels.length > 0
        ? ' ' + taskLabels.map(l => `#${l}`).join(' ')
        : '';
      editInput.value = `${task.content}${currentLabelsSuffix}`;

      const editDescInput = document.createElement('textarea');
      editDescInput.className = 'task-edit-desc';
      editDescInput.placeholder = 'Descrição (suporta markdown)...';
      editDescInput.rows = 3;
      editDescInput.value = task.description || '';

      const editActionsRow = document.createElement('div');
      editActionsRow.className = 'edit-actions-row';

      const editDateInput = document.createElement('input');
      editDateInput.type = 'date';
      editDateInput.className = 'task-edit-date';
      editDateInput.title = 'Data de vencimento';
      editDateInput.value = task.due?.date ? task.due.date.substring(0, 10) : '';

      const editButtonsWrap = document.createElement('div');
      editButtonsWrap.className = 'edit-buttons-wrap';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-edit-action btn-edit-cancel';
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.title = 'Cancelar edição (Esc)';
      cancelBtn.addEventListener('click', () => {
        state.editingTaskId = null;
        renderAll();
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'submit';
      saveBtn.className = 'btn-edit-action btn-edit-save';
      saveBtn.textContent = 'Salvar';
      saveBtn.title = 'Salvar alterações (Enter ou Ctrl+Enter)';

      editButtonsWrap.appendChild(cancelBtn);
      editButtonsWrap.appendChild(saveBtn);

      editActionsRow.appendChild(editDateInput);
      editActionsRow.appendChild(editButtonsWrap);

      editDescInput.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          editForm.requestSubmit();
        } else if (e.key === 'Escape') {
          state.editingTaskId = null;
          renderAll();
        }
      });

      editInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          state.editingTaskId = null;
          renderAll();
        }
      });

      editForm.addEventListener('submit', e => {
        e.preventDefault();
        saveEditedTask(task, editInput.value, editDateInput.value, editDescInput.value);
      });

      editForm.appendChild(editInput);
      editForm.appendChild(editDescInput);
      editForm.appendChild(editActionsRow);
      contentWrap.appendChild(editForm);

      setTimeout(() => {
        editInput.focus();
        editInput.setSelectionRange(editInput.value.length, editInput.value.length);
      }, 0);
    } else {
      const title = document.createElement('div');
      title.className = 'task-title';
      title.textContent = task.content;
      contentWrap.appendChild(title);

      if (task.description && task.description.trim()) {
        const desc = document.createElement('div');
        desc.className = 'task-desc';
        desc.innerHTML = renderMarkdown(task.description);
        contentWrap.appendChild(desc);
      }

      const meta = document.createElement('div');
      meta.className = 'task-meta';

      // Mostra as tags da tarefa APENAS com o texto (sem o #)
      taskLabels.forEach(lbl => {
        const lblTag = document.createElement('span');
        lblTag.className = 'tag-project';
        lblTag.textContent = lbl;
        lblTag.title = `Filtrar por ${lbl}`;
        lblTag.addEventListener('click', () => {
          state.activeFilter = `label:${lbl}`;
          saveCache();
          renderAll();
        });
        meta.appendChild(lblTag);
      });

      if (task.priority && task.priority > 1) {
        const prioMap = { 4: 'P1', 3: 'P2', 2: 'P3' };
        const prioTag = document.createElement('span');
        prioTag.className = 'tag-priority';
        prioTag.textContent = prioMap[task.priority];
        meta.appendChild(prioTag);
      }

      if (task.due && task.due.date) {
        const dueTag = document.createElement('span');
        const overdue = isOverdue(task);
        const isTodayDue = task.due.date.substring(0, 10) === getTodayIso();
        dueTag.className = `tag-due ${overdue ? 'overdue' : ''} ${isTodayDue ? 'today' : ''}`.trim();
        dueTag.textContent = formatDueDate(task.due.date);
        meta.appendChild(dueTag);
      }

      if (subtasks.length > 0) {
        const subTag = document.createElement('span');
        subTag.className = 'tag-subtasks';
        subTag.textContent = `↳ ${subtasks.length}`;
        subTag.title = `Abrir subtarefas (${subtasks.length})`;
        subTag.addEventListener('click', () => openSubtasksModal(task));
        meta.appendChild(subTag);
      }

      if (meta.children.length > 0) {
        contentWrap.appendChild(meta);
      }
    }

    if (!isEditing) {
      left.appendChild(checkboxWrap);
    }
    left.appendChild(contentWrap);
    li.appendChild(left);

    // Durante a edição, os botões de ação e excluir NUNCA são renderizados
    if (!isEditing) {
      const actions = document.createElement('div');
      actions.className = 'task-actions';

      const subtaskBtn = document.createElement('button');
      subtaskBtn.type = 'button';
      subtaskBtn.className = 'btn-task-action';
      subtaskBtn.title = `Subtarefas (${subtasks.length})`;
      subtaskBtn.setAttribute('aria-label', `Subtarefas (${subtasks.length})`);
      if (subtasks.length > 0) {
        subtaskBtn.innerHTML = `${ICONS.SUBTASK}<span class="btn-subtask-count">${subtasks.length}</span>`;
      } else {
        subtaskBtn.innerHTML = ICONS.SUBTASK;
      }
      subtaskBtn.addEventListener('click', () => openSubtasksModal(task));
      actions.appendChild(subtaskBtn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-task-action';
      editBtn.title = 'Editar tarefa';
      editBtn.setAttribute('aria-label', 'Editar tarefa');
      editBtn.innerHTML = ICONS.EDIT;
      editBtn.addEventListener('click', () => {
        state.editingTaskId = String(task.id);
        renderAll();
      });
      actions.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-task-action';
      delBtn.title = 'Excluir tarefa';
      delBtn.setAttribute('aria-label', 'Excluir tarefa');
      delBtn.innerHTML = ICONS.CLOSE;
      delBtn.addEventListener('click', () => deleteTask(task.id));
      actions.appendChild(delBtn);

      li.appendChild(actions);
    }
    els.tasksList.appendChild(li);
  });

  els.tasksCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'tarefa' : 'tarefas'}`;

  if (els.footerTag) {
    if (state.activeFilter === 'today') {
      els.footerTag.textContent = 'hoje';
      els.footerTag.className = 'footer-tag today';
      els.footerTag.title = 'Filtrando por hoje (clique para limpar)';
      els.footerTag.classList.remove('hidden');
    } else if (state.activeFilter.startsWith('label:')) {
      const lblName = state.activeFilter.slice('label:'.length);
      els.footerTag.textContent = lblName;
      els.footerTag.className = 'footer-tag';
      els.footerTag.title = `Filtrando por ${lblName} (clique para limpar)`;
      els.footerTag.classList.remove('hidden');
    } else {
      els.footerTag.textContent = '';
      els.footerTag.className = 'footer-tag hidden';
    }
  }
}

function formatDueDate(dateStr) {
  const cleanDate = dateStr.substring(0, 10);
  const today = getTodayIso();
  const tomorrow = getOffsetDateIso(1);
  if (cleanDate === today) return 'Hoje';
  if (cleanDate === tomorrow) return 'Amanhã';
  if (cleanDate < today) return `Atrasada (${cleanDate.split('-').reverse().slice(0, 2).join('/')})`;
  const parts = cleanDate.split('-');
  return `${parts[2]}/${parts[1]}`;
}

/* ==========================================================================
   INTERFACE AUXILIAR & EVENTOS
   ========================================================================== */
function updateSyncStatus(text, isSynced = false) {
  if (!els.syncStatus) return;
  const lower = String(text || '').toLowerCase();
  els.syncStatus.textContent = lower;
  const isSyncing = lower.includes('sincronizando');
  els.syncStatus.className = 'meta-sync' + (isSynced ? ' synced' : (isSyncing ? ' syncing' : ''));
}

function updateSyncBadge(text, isSyncing) {
  updateSyncStatus(text, !isSyncing && String(text).toLowerCase().includes('ok'));
}

function showAlert(msg) {
  els.alertBox.innerHTML = `
    <span>${escapeHtml(msg)}</span>
    <button type="button" class="btn btn-icon" onclick="document.getElementById('alert-box').classList.add('hidden')" aria-label="Fechar alerta">${ICONS.CLOSE}</button>
  `;
  els.alertBox.classList.remove('hidden');
}

function hideAlert() {
  els.alertBox.classList.add('hidden');
}

function openSettingsModal() {
  els.apiTokenInput.value = state.token;
  els.settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  els.settingsModal.classList.add('hidden');
}

function saveTokenAndSync() {
  const newToken = els.apiTokenInput.value.trim();
  state.token = newToken;
  localStorage.setItem(STORAGE_KEYS.TOKEN, newToken);
  closeSettingsModal();
  if (newToken) {
    syncWithTodoist();
  } else {
    updateSyncStatus('modo local', false);
    renderAll();
  }
}

function bindEvents() {
  els.btnToggleAdd.addEventListener('click', () => {
    if (els.addTaskSection.classList.contains('hidden')) {
      openAddTaskBox();
    } else {
      closeAddTaskBox();
    }
  });

  els.btnCancelAdd.addEventListener('click', closeAddTaskBox);

  // Eventos do modal de subtarefas
  els.addSubtaskForm.addEventListener('submit', handleAddSubtask);
  els.btnCloseSubtasks.addEventListener('click', closeSubtasksModal);
  els.btnDoneSubtasks.addEventListener('click', closeSubtasksModal);

  els.taskInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeAddTaskBox();
    }
  });

  if (els.taskDescInput) {
    els.taskDescInput.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        els.addTaskForm.requestSubmit();
      } else if (e.key === 'Escape') {
        closeAddTaskBox();
      }
    });
  }

  els.addTaskForm.addEventListener('submit', handleAddTask);

  els.taskDueSelect.addEventListener('change', () => {
    if (els.taskDueSelect.value === 'custom') {
      els.taskCustomDate.classList.remove('hidden');
      if (!els.taskCustomDate.value) {
        els.taskCustomDate.value = getTodayIso();
      }
      els.taskCustomDate.focus();
    } else {
      els.taskCustomDate.classList.add('hidden');
    }
  });

  els.btnSync.addEventListener('click', () => {
    syncWithTodoist();
  });

  if (els.syncStatus) {
    els.syncStatus.addEventListener('click', () => {
      syncWithTodoist();
    });
  }

  if (els.footerTag) {
    els.footerTag.addEventListener('click', () => {
      state.activeFilter = 'all';
      saveCache();
      renderAll();
    });
  }

  els.btnSettings.addEventListener('click', openSettingsModal);
  els.btnCloseSettings.addEventListener('click', closeSettingsModal);

  els.toggleShowToken.addEventListener('change', e => {
    els.apiTokenInput.type = e.target.checked ? 'text' : 'password';
  });

  els.btnSaveSettings.addEventListener('click', saveTokenAndSync);

  els.apiTokenInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTokenAndSync();
    }
  });

  els.btnCreateProject.addEventListener('click', async () => {
    const name = els.newProjectInput.value.trim();
    if (!name) return;
    els.btnCreateProject.disabled = true;
    try {
      await createLabel(name);
      els.newProjectInput.value = '';
    } catch (err) {
      showAlert(`Erro ao criar label: ${err.message}`);
    } finally {
      els.btnCreateProject.disabled = false;
    }
  });

  els.newProjectInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      els.btnCreateProject.click();
    }
  });

  els.btnClearCache.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEYS.TASKS);
    localStorage.removeItem(STORAGE_KEYS.LABELS);
    localStorage.removeItem(STORAGE_KEYS.LAST_SYNC);
    state.tasks = [];
    state.labels = [];
    renderAll();
    closeSettingsModal();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token) {
      syncWithTodoist();
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
