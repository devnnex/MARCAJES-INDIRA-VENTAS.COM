const API = "https://script.google.com/macros/s/AKfycbzBUHGSo3tQASa_OA9KJmY2Niqra384kgSjodshMNP-b-Dh0VyBq9lJB1fKba0sWfHQrA/exec";

const COP = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0
});

const premiumModal = Swal.mixin({
  background: "transparent",
  buttonsStyling: false,
  confirmButtonText: "Entendido",
  customClass: {
    popup: "apple-modal",
    title: "apple-modal-title",
    htmlContainer: "apple-modal-text",
    actions: "apple-modal-actions",
    confirmButton: "apple-modal-btn",
    cancelButton: "apple-modal-btn apple-modal-btn-secondary"
  },
  showClass: {
    popup: "apple-modal-show"
  },
  hideClass: {
    popup: "apple-modal-hide"
  }
});

let currentHourRate = null;
let currentWorkers = [];
let attendanceMode = "single";
let selectedBatchWorkers = new Set();
let adminUnlocked = false;
let liquidationHistory = [];
const visualDaysBaselineByWorker = new Map();
const readCache = new Map();
const inFlightReads = new Map();

const ADMIN_PIN = "5678";
const PROTECTED_SECTIONS = new Set(["dashboard", "workers", "history"]);
const READ_CACHE_MS = 7000;
const FAST_CACHE_MS = 3000;

function formatCOP(value){
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)){
    return COP.format(0);
  }

  return COP.format(Math.round(numericValue));
}

function formatHoursValue(value){
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)){
    return "0";
  }

  return Number.isInteger(numericValue) ? String(numericValue) : numericValue.toFixed(2).replace(/\.?0+$/, "");
}

function showPremiumModal(options = {}){
  return premiumModal.fire(options);
}

function getWorkerHourlyRate(worker = {}){
  const candidates = [
    worker.hourly_rate,
    worker.hourlyRateRaw,
    worker.workerHourlyRate
  ];

  for (const candidate of candidates){
    if (candidate === "" || candidate === null || candidate === undefined){
      continue;
    }

    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue > 0){
      return numericValue;
    }
  }

  return null;
}

function escapeHTML(value){
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getWorkerNameById(workerId){
  const matchedWorker = currentWorkers.find(worker => String(worker.id) === String(workerId));
  return matchedWorker?.name || "Trabajador";
}

function setAttendanceMode(mode = "single"){
  attendanceMode = mode === "multi" ? "multi" : "single";

  const isMulti = attendanceMode === "multi";
  const modeSingleBtn = document.getElementById("modeSingleBtn");
  const modeMultiBtn = document.getElementById("modeMultiBtn");
  const multiWorkerPanel = document.getElementById("multiWorkerPanel");

  if (modeSingleBtn){
    modeSingleBtn.classList.toggle("active", !isMulti);
  }

  if (modeMultiBtn){
    modeMultiBtn.classList.toggle("active", isMulti);
  }

  if (multiWorkerPanel){
    multiWorkerPanel.classList.toggle("visible", isMulti);
    multiWorkerPanel.setAttribute("aria-hidden", String(!isMulti));
  }

  if (isMulti && selectedBatchWorkers.size === 0 && workerSelect.value){
    selectedBatchWorkers.add(String(workerSelect.value));
  }

  renderMultiWorkerList(currentWorkers);
}

function handleBatchWorkerToggle(workerId, isSelected){
  const normalizedId = String(workerId || "").trim();
  if (!normalizedId){
    return;
  }

  if (isSelected){
    selectedBatchWorkers.add(normalizedId);
  } else {
    selectedBatchWorkers.delete(normalizedId);
  }
}

function toggleAllBatchWorkers(shouldSelect){
  const workerIds = currentWorkers.map(worker => String(worker.id));
  selectedBatchWorkers = shouldSelect ? new Set(workerIds) : new Set();
  renderMultiWorkerList(currentWorkers);
}

function renderMultiWorkerList(workers = []){
  const multiWorkerList = document.getElementById("multiWorkerList");
  if (!multiWorkerList){
    return;
  }

  const validWorkers = Array.isArray(workers) ? workers : [];

  if (!validWorkers.length){
    multiWorkerList.innerHTML = `<div class="multi-worker-empty">No hay trabajadores disponibles para seleccion multiple.</div>`;
    return;
  }

  const availableIds = new Set(validWorkers.map(worker => String(worker.id)));
  selectedBatchWorkers = new Set([...selectedBatchWorkers].filter(workerId => availableIds.has(workerId)));

  multiWorkerList.innerHTML = validWorkers.map(worker => {
    const workerId = String(worker.id);
    const workerName = escapeHTML(worker.name || "Sin nombre");
    const checkedAttribute = selectedBatchWorkers.has(workerId) ? "checked" : "";

    return `
      <label class="multi-worker-item">
        <input type="checkbox" class="multi-worker-check" data-worker-id="${escapeHTML(workerId)}" ${checkedAttribute}>
        <span>${workerName}</span>
      </label>
    `;
  }).join("");

  multiWorkerList.querySelectorAll(".multi-worker-check").forEach(input => {
    input.addEventListener("change", event => {
      const target = event.currentTarget;
      handleBatchWorkerToggle(target.dataset.workerId, target.checked);
    });
  });
}

async function openAttendanceOverviewModal(){
  setGlobalLoader(true, {
    title: "Actualizando turnos",
    text: "Estamos consultando el estado actual de los trabajadores."
  });

  let workers = currentWorkers;

  try {
    workers = await getWorkersData();
    renderWorkers(workers);
  } finally {
    setGlobalLoader(false);
  }

  const validWorkers = Array.isArray(workers) ? workers : [];
  const activeCount = validWorkers.filter(worker => parseWorkerActiveState(worker.active)).length;
  const inactiveCount = Math.max(validWorkers.length - activeCount, 0);
  const renderOverviewItems = filter => {
    const filteredWorkers = validWorkers.filter(worker => {
      const isActive = parseWorkerActiveState(worker.active);
      if (filter === "active"){
        return isActive;
      }
      if (filter === "inactive"){
        return !isActive;
      }
      return true;
    });

    return filteredWorkers.length
      ? filteredWorkers.map(worker => {
          const isActive = parseWorkerActiveState(worker.active);
          return `
            <div class="attendance-overview-item">
              <span>${escapeHTML(worker.name || "Sin nombre")}</span>
              ${isActive
                ? `<strong class="attendance-status-in">EN TURNO</strong>`
                : `<strong class="attendance-status-out">FUERA DE TURNO</strong>`}
            </div>
          `;
        }).join("")
      : `<div class="attendance-overview-empty">No hay trabajadores para este filtro.</div>`;
  };

  await showPremiumModal({
    title: "Vista general de turnos",
    html: `
      <div class="attendance-overview-modal">
        <div class="attendance-overview-summary">
          <button class="attendance-overview-kpi" type="button" data-filter="active">
            <span>En turno</span>
            <strong>${activeCount}</strong>
          </button>
          <button class="attendance-overview-kpi" type="button" data-filter="inactive">
            <span>Fuera de turno</span>
            <strong>${inactiveCount}</strong>
          </button>
        </div>

        <div class="attendance-overview-list" id="attendanceOverviewList">
          ${validWorkers.length ? renderOverviewItems("all") : `<div class="attendance-overview-empty">No hay trabajadores disponibles.</div>`}
        </div>
      </div>
    `,
    confirmButtonText: "Entendido",
    didOpen: () => {
      const overviewList = document.getElementById("attendanceOverviewList");
      const filterButtons = document.querySelectorAll(".attendance-overview-kpi");
      let selectedFilter = "all";

      filterButtons.forEach(button => {
        button.addEventListener("click", () => {
          const nextFilter = button.dataset.filter || "all";
          selectedFilter = selectedFilter === nextFilter ? "all" : nextFilter;

          filterButtons.forEach(filterButton => {
            filterButton.classList.toggle(
              "selected",
              selectedFilter !== "all" && filterButton.dataset.filter === selectedFilter
            );
          });

          if (overviewList){
            overviewList.innerHTML = validWorkers.length
              ? renderOverviewItems(selectedFilter)
              : `<div class="attendance-overview-empty">No hay trabajadores disponibles.</div>`;
          }
        });
      });
    }
  });
}

function getRateElements(){
  return {
    currentRateLabel: document.getElementById("currentRateValue"),
    rateInput: document.getElementById("hourRate")
  };
}

function clearRateInput(){
  const rateInput = document.getElementById("hourRate");
  if (rateInput){
    rateInput.value = "";
  }
}

function renderCurrentRate(value){
  const currentRateLabel = document.getElementById("currentRateValue");
  const currentRateDisplay = document.getElementById("currentRateDisplay");
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0){
    return;
  }

  const formattedRate = formatCOP(numericValue);

  if (currentRateLabel){
    currentRateLabel.textContent = formattedRate;
    currentRateLabel.innerText = formattedRate;
    currentRateLabel.setAttribute("data-rate-value", String(numericValue));
  }

  if (currentRateDisplay){
    currentRateDisplay.textContent = formattedRate;
    currentRateDisplay.innerText = formattedRate;
    currentRateDisplay.setAttribute("data-rate-value", String(numericValue));
  }
}

function getWorkerFormFields(){
  return {
    nameInput: document.getElementById("name"),
    phoneInput: document.getElementById("phone"),
    emailInput: document.getElementById("email")
  };
}

function wait(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMinutes(mins){
  if (mins < 60) return mins + " min";

  const h = Math.floor(mins / 60);
  const m = mins % 60;

  return m === 0 ? `${h}h` : `${h}h ${m} m`;
}

function toggleRateBoxVisibility(sectionId){
  const rateBox = document.getElementById("rateBox");
  if (!rateBox){
    return;
  }

  rateBox.classList.toggle("hidden-by-section", sectionId === "time" || sectionId === "history");
}

function setActiveSectionUI(id){
  document.querySelectorAll(".section")
    .forEach(section => section.classList.remove("active"));

  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".sidebar .nav-btn")
    .forEach(button => button.classList.toggle("active", button.dataset.section === id));
  toggleRateBoxVisibility(id);
}

function isProtectedSection(id){
  return PROTECTED_SECTIONS.has(id);
}

async function requestAdminAccess(){
  const { isConfirmed, value } = await showPremiumModal({
    title: "PIN de administrador",
    html: `
      <div class="apple-modal-form">
        <label class="apple-modal-field">
          <span>Ingresa el PIN de 4 digitos</span>
          <input id="adminPinInput" class="apple-modal-input-field" type="password" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="****">
        </label>
      </div>
    `,
    confirmButtonText: "Ingresar",
    showCancelButton: true,
    cancelButtonText: "Cancelar",
    allowOutsideClick: false,
    allowEscapeKey: false,
    focusConfirm: false,
    didOpen: () => {
      const pinInput = document.getElementById("adminPinInput");
      if (pinInput){
        pinInput.focus();
        pinInput.addEventListener("input", () => {
          pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 4);
        });
      }
    },
    preConfirm: () => {
      const pinInput = document.getElementById("adminPinInput");
      const pinValue = (pinInput?.value || "").replace(/\D/g, "").slice(0, 4);

      if (pinValue.length !== 4){
        Swal.showValidationMessage("El PIN debe tener 4 digitos.");
        return false;
      }

      return pinValue;
    }
  });

  if (!isConfirmed){
    return false;
  }

  if (value !== ADMIN_PIN){
    await showPremiumModal({
      icon: "error",
      title: "PIN incorrecto",
      text: "No tienes permisos para entrar a esta seccion."
    });
    return false;
  }

  adminUnlocked = true;
  await showPremiumModal({
    icon: "success",
    title: "Acceso concedido",
    text: "Ya puedes entrar a Dashboard y Trabajadores."
  });
  return true;
}

async function showSection(id){
  if (isProtectedSection(id) && !adminUnlocked){
    const hasAccess = await requestAdminAccess();
    if (!hasAccess){
      if (id !== "time"){
        setActiveSectionUI("time");
        await loadTimeSection();
      }
      return;
    }
  }

  setActiveSectionUI(id);

  if (id === "workers"){
    await loadWorkers();
  }

  if (id === "dashboard"){
    await loadDashboard();
  }

  if (id === "time"){
    await loadTimeSection();
  }

  if (id === "history"){
    await Promise.allSettled([
      loadLiquidationsHistory({ showLoader: true }),
      loadWorkers()
    ]);
    populateLiquidationWorkerFilter(liquidationHistory);
    renderLiquidationsHistory();
  }
}

async function loadTimeSection(){
  setGlobalLoader(true, {
    title: "Cargando marcajes",
    text: "Estamos preparando la vista para consultar los registros."
  });

  try {
    await loadWorkers();
    await loadTimeLogs({ showLoader: true });
  } catch (error){
    setGlobalLoader(false);
    throw error;
  } finally {
    setGlobalLoader(false);
  }
}

function getApiCacheKey(action, data = {}){
  return `${action}:${JSON.stringify(data || {})}`;
}

function isReadAction(action){
  return /^get/i.test(action);
}

function invalidateReadCache(){
  readCache.clear();
  inFlightReads.clear();
}

async function api(action, data = {}, {
  cacheMs = 0,
  force = false
} = {}){
  const canCache = isReadAction(action) && cacheMs > 0;
  const cacheKey = canCache ? getApiCacheKey(action, data) : "";

  if (canCache && !force){
    const cached = readCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheMs){
      return cached.value;
    }

    const inFlight = inFlightReads.get(cacheKey);
    if (inFlight){
      return inFlight;
    }
  }

  const request = fetch(API, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify({ action, ...data })
  })
    .then(async res => {
      const rawResponse = await res.text();
      if (!rawResponse || rawResponse.trim() === "" || rawResponse.trim() === "undefined"){
        return {};
      }

      return JSON.parse(rawResponse);
    })
    .then(result => {
      if (canCache){
        readCache.set(cacheKey, {
          timestamp: Date.now(),
          value: result
        });
      } else if (!isReadAction(action)){
        invalidateReadCache();
      }

      return result;
    })
    .finally(() => {
      if (canCache){
        inFlightReads.delete(cacheKey);
      }
    });

  if (canCache){
    inFlightReads.set(cacheKey, request);
  }

  return request;
}

async function addWorker(){
  const { nameInput, phoneInput, emailInput } = getWorkerFormFields();
  const payload = {
    name: nameInput.value.trim(),
    phone: phoneInput.value.trim(),
    email: emailInput.value.trim()
  };

  if (!payload.name){
    showPremiumModal({
      icon: "warning",
      title: "Nombre requerido",
      text: "Ingresa al menos el nombre del trabajador antes de guardar."
    });
    return;
  }

  setGlobalLoader(true, {
    title: "Guardando trabajador",
    text: "Estamos registrando al trabajador y actualizando la vista."
  });

  let shouldShowSuccess = false;

  try {
    const result = await api("addWorker", payload);
    nameInput.value = "";
    phoneInput.value = "";
    emailInput.value = "";

    insertOptimisticWorker(result, payload);
    shouldShowSuccess = true;
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadWorkers({ force: true }),
    loadDashboard({ force: true })
  ]);

  if (shouldShowSuccess){
    await wait(80);
    await showPremiumModal({
      icon: "success",
      title: "Cambio exitoso",
      text: "Recuerda refrescarlo desde el boton refrescar para ver los cambios."
    });
  }
}

async function getWorkersData({ force = false } = {}){
  return api("getWorkers", {}, {
    cacheMs: READ_CACHE_MS,
    force
  });
}

function renderWorkers(workers = currentWorkers){
  currentWorkers = Array.isArray(workers) ? workers : [];
  const searchInput = document.getElementById("workerSearch");
  const cardsContainer = document.getElementById("workersCards");
  const q = (searchInput?.value || "").toLowerCase();

  const filtered = currentWorkers.filter(worker =>
    (worker.name || "").toLowerCase().includes(q)
  );

  cardsContainer.innerHTML = filtered.map(worker => {
    const maxHours = 48;
    const progress = Math.min((worker.hours / maxHours) * 100, 100);
    const money = formatCOP(worker.pay || 0);
    const safeWorkerName = escapeHTML(worker.name || "Sin nombre");
    const workerRate = getWorkerHourlyRate(worker);
    const rateTitle = workerRate
      ? `Tarifa individual: ${formatCOP(workerRate)}`
      : "Configurar tarifa individual";
    const liqDate = worker.lastLiquidation
      ? new Date(worker.lastLiquidation).toLocaleDateString("es-CO", {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric"
        })
      : "Sin liquidar";

    const workerId = String(worker.id);
    const rawDays = Number(worker.days || 0);
    const baselineDays = visualDaysBaselineByWorker.get(workerId);
    let visualDays = rawDays;

    if (typeof baselineDays === "number"){
      if (rawDays < baselineDays){
        // El backend reinicio dias; ya no necesitamos el baseline visual.
        visualDaysBaselineByWorker.delete(workerId);
      } else {
        visualDays = Math.max(0, rawDays - baselineDays);
      }
    }

    const status = worker.active
      ? `<div style="color:#00e676;font-weight:bold">EN TURNO</div>`
      : `<div style="color:#9e9e9e">Fuera de turno</div>`;

    const timer = worker.active
      ? `<div class="liveTimer" data-start="${worker.activeStart}"></div>`
      : "";

    return `
      <div class="worker-card">
        <div class="worker-header">
          <div class="worker-name-row">
            <span class="worker-name">${safeWorkerName}</span>
            <button class="worker-rate-btn" type="button" onclick="openWorkerRateModal('${worker.id}')" aria-label="Configurar tarifa por hora" title="${escapeHTML(rateTitle)}">$</button>
            <button class="edit-worker-btn" type="button" onclick="editWorker('${worker.id}')" aria-label="Editar trabajador">&#9998;</button>
          </div>
          <span>${money}</span>
        </div>

        <div>Dias trabajados: ${visualDays}</div>

        ${status}
        ${timer}

        <div class="progress-bar">
          <div class="progress" style="width:${progress}%"></div>
        </div>

        <div style="color:#00c853;font-size:12px;margin-top:6px">
          Ultima liquidacion: ${liqDate}
        </div>

        <div class="card-actions">
          <button class="liquidate-btn" onclick="liquidate('${worker.id}')">Liquidar</button>
          <button class="delete-btn" onclick="deleteWorker('${worker.id}')">Eliminar</button>
        </div>
      </div>
    `;
  }).join("");

  fillWorkerSelects(currentWorkers);
}

function handleWorkerSearch(){
  renderWorkers(currentWorkers);
}

async function loadWorkers({ force = false } = {}){
  const workers = await getWorkersData({ force });
  renderWorkers(workers);
  return workers;
}

async function refreshWorkers(){
  setGlobalLoader(true, {
    title: "Refrescando trabajadores",
    text: "Estamos cargando la lista mas reciente desde el backend."
  });

  try {
    await loadWorkers({ force: true });
  } finally {
    setGlobalLoader(false);
  }
}

async function syncWorkersUI({
  match,
  attempts = 6,
  delayMs = 450,
  loaderTitle = "Actualizando trabajadores",
  loaderText = "Estamos sincronizando la informacion mas reciente."
} = {}){
  let workers = [];

  for (let attempt = 0; attempt < attempts; attempt += 1){
    setGlobalLoader(true, {
      title: loaderTitle,
      text: loaderText
    });

    workers = await getWorkersData();
    renderWorkers(workers);

    if (!match || match(workers)){
      return workers;
    }

    await wait(delayMs);
  }

  return workers;
}

function fillWorkerSelects(workers){
  const selectedWorker = workerSelect.value;
  const selectedLiquidWorker = liquidWorker.value;

  workerSelect.innerHTML = "";
  liquidWorker.innerHTML = "";

  workers.forEach(worker => {
    const option = `<option value="${worker.id}">${worker.name}</option>`;
    workerSelect.innerHTML += option;
    liquidWorker.innerHTML += option;
  });

  if (selectedWorker && workers.some(worker => String(worker.id) === String(selectedWorker))){
    workerSelect.value = selectedWorker;
  }

  if (selectedLiquidWorker && workers.some(worker => String(worker.id) === String(selectedLiquidWorker))){
    liquidWorker.value = selectedLiquidWorker;
  }

  const availableIds = new Set(workers.map(worker => String(worker.id)));
  selectedBatchWorkers = new Set([...selectedBatchWorkers].filter(workerId => availableIds.has(workerId)));

  if (selectedBatchWorkers.size === 0 && workerSelect.value){
    selectedBatchWorkers.add(String(workerSelect.value));
  }

  renderMultiWorkerList(workers);
}

async function deleteWorker(id){
  setGlobalLoader(true, {
    title: "Eliminando trabajador",
    text: "Estamos actualizando la lista para reflejar el cambio."
  });

  try {
    await api("deleteWorker", { id });
    removeOptimisticWorker(id);
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadWorkers({ force: true }),
    loadDashboard({ force: true })
  ]);
}

async function editWorker(id, currentName, currentPhone, currentEmail){
  const workerId = String(id || "").trim();
  if (!workerId){
    showPremiumModal({
      icon: "warning",
      title: "Trabajador no valido",
      text: "No se pudo identificar el trabajador a editar."
    });
    return;
  }

  const workerData = currentWorkers.find(worker => String(worker.id) === workerId) || {};
  const safeName = escapeHTML(currentName ?? workerData.name ?? "");
  const safePhone = escapeHTML(currentPhone ?? workerData.phone ?? "");
  const safeEmail = escapeHTML(currentEmail ?? workerData.email ?? "");

  const { isConfirmed, value } = await showPremiumModal({
    title: "Editar trabajador",
    html: `
      <div class="apple-modal-form">
        <label class="apple-modal-field">
          <span>Nombre</span>
          <input id="swalWorkerName" class="apple-modal-input-field" value="${safeName}" placeholder="Nombre">
        </label>
        <label class="apple-modal-field">
          <span>Telefono</span>
          <input id="swalWorkerPhone" class="apple-modal-input-field" value="${safePhone}" placeholder="Telefono">
        </label>
        <label class="apple-modal-field">
          <span>Email</span>
          <input id="swalWorkerEmail" class="apple-modal-input-field" value="${safeEmail}" placeholder="Correo">
        </label>
      </div>
    `,
    confirmButtonText: "Guardar cambios",
    showCancelButton: true,
    cancelButtonText: "Cancelar",
    focusConfirm: false,
    preConfirm: () => {
      const updatedName = document.getElementById("swalWorkerName").value.trim();
      const updatedPhone = document.getElementById("swalWorkerPhone").value.trim();
      const updatedEmail = document.getElementById("swalWorkerEmail").value.trim();

      if (!updatedName){
        Swal.showValidationMessage("El nombre es obligatorio.");
        return false;
      }

      return {
        name: updatedName,
        phone: updatedPhone,
        email: updatedEmail
      };
    }
  });

  if (!isConfirmed || !value){
    return;
  }

  setGlobalLoader(true, {
    title: "Guardando cambios",
    text: "Estamos actualizando la informacion del trabajador."
  });

  try {
    await api("updateWorker", {
      id: workerId,
      name: value.name,
      phone: value.phone,
      email: value.email
    });

    updateOptimisticWorker(workerId, value);
    if (workerSelect.value && String(workerSelect.value) === workerId){
      updateSelectedWorkerName(value.name);
    }
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadWorkers({ force: true }),
    adminUnlocked ? loadDashboard({ force: true }) : Promise.resolve()
  ]);

  await wait(80);
  await showPremiumModal({
    icon: "success",
    title: "Cambio exitoso",
    text: "Recuerda refrescarlo desde el boton refrescar para ver los cambios."
  });
}

async function openWorkerRateModal(id){
  const workerId = String(id || "").trim();
  if (!workerId){
    showPremiumModal({
      icon: "warning",
      title: "Trabajador no valido",
      text: "No se pudo identificar el trabajador para configurar la tarifa."
    });
    return;
  }

  const workerData = currentWorkers.find(worker => String(worker.id) === workerId) || {};
  const workerName = workerData.name || "Trabajador";
  const currentRate = getWorkerHourlyRate(workerData);
  const rateHint = currentRate
    ? `Tarifa actual: ${formatCOP(currentRate)}`
    : "Usando tarifa global";

  const { isConfirmed, value } = await showPremiumModal({
    title: "Configurar tarifa por hora",
    html: `
      <div class="worker-rate-modal">
        <div class="worker-rate-context">
          <span>Trabajador</span>
          <strong>${escapeHTML(workerName)}</strong>
        </div>

        <label class="apple-modal-field">
          <span>Valor por hora</span>
          <input id="swalWorkerRate" class="apple-modal-input-field" type="number" inputmode="numeric" min="1" step="1" value="${currentRate ?? ""}" placeholder="Ej: 10000">
        </label>

        <p class="worker-rate-hint">${rateHint}</p>
      </div>
    `,
    confirmButtonText: "Guardar",
    showCancelButton: true,
    cancelButtonText: "Cancelar",
    focusConfirm: false,
    customClass: {
      popup: "apple-modal",
      title: "apple-modal-title",
      htmlContainer: "apple-modal-text",
      actions: "apple-modal-actions",
      confirmButton: "apple-modal-btn worker-rate-save-btn",
      cancelButton: "apple-modal-btn apple-modal-btn-secondary"
    },
    didOpen: () => {
      const rateInput = document.getElementById("swalWorkerRate");
      if (rateInput){
        rateInput.focus();
        rateInput.select();
      }
    },
    preConfirm: () => {
      const rateInput = document.getElementById("swalWorkerRate");
      const numericRate = Number(rateInput?.value || 0);

      if (!Number.isFinite(numericRate) || numericRate <= 0){
        Swal.showValidationMessage("Ingresa una tarifa mayor a cero.");
        return false;
      }

      return Math.round(numericRate);
    }
  });

  if (!isConfirmed || !value){
    return;
  }

  setGlobalLoader(true, {
    title: "Guardando tarifa",
    text: "Estamos actualizando el valor por hora del trabajador."
  });

  try {
    await api("setWorkerRate", {
      worker: workerId,
      rate: value
    });

    currentWorkers = currentWorkers.map(worker =>
      String(worker.id) === workerId
        ? { ...worker, hourly_rate: value, hourlyRate: value }
        : worker
    );
    renderWorkers(currentWorkers);
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadWorkers({ force: true }),
    adminUnlocked ? loadDashboard({ force: true }) : Promise.resolve()
  ]);

  await showPremiumModal({
    icon: "success",
    title: "Tarifa guardada",
    text: `${workerName} ahora tiene una tarifa de ${formatCOP(value)} por hora.`
  });
}

function getSelectedAttendanceWorkerIds(){
  if (attendanceMode === "multi"){
    const availableIds = new Set(currentWorkers.map(worker => String(worker.id)));
    return [...selectedBatchWorkers].filter(workerId => availableIds.has(workerId));
  }

  const selectedWorkerId = String(workerSelect.value || "").trim();
  return selectedWorkerId ? [selectedWorkerId] : [];
}

function formatAttendanceTime(rawTime){
  if (!rawTime){
    return "ahora";
  }

  const parsedTime = new Date(rawTime);
  if (Number.isNaN(parsedTime.getTime())){
    return "ahora";
  }

  return parsedTime.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatLiquidationDate(rawDate){
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())){
    return "Fecha no disponible";
  }

  const datePart = date
    .toLocaleDateString("es-CO", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric"
    })
    .replace(/,/g, "")
    .replace(/\./g, "");

  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });

  return `${datePart} ${timePart}`;
}

function normalizeSearchText(value){
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getLiquidationDate(rawDate){
  const date = new Date(rawDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getLiquidationDayKey(rawDate){
  const date = getLiquidationDate(rawDate);
  if (!date){
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLiquidationDayLabel(rawDate){
  const date = getLiquidationDate(rawDate);
  if (!date){
    return "Fecha no disponible";
  }

  return date.toLocaleDateString("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  })
  .replace(/,/g, "")
  .replace(/\./g, "");
}

function buildBatchAttendanceRows(results, maxRows = 8){
  const visibleRows = results.slice(0, maxRows);
  const remainingCount = Math.max(results.length - maxRows, 0);

  const rows = visibleRows.map(result => `
    <div class="apple-liquidation-row">
      <span>${escapeHTML(result.name || getWorkerNameById(result.workerId))}</span>
      <strong>${formatAttendanceTime(result.time)}</strong>
    </div>
  `).join("");

  if (!remainingCount){
    return rows;
  }

  return `${rows}
    <div class="apple-liquidation-row">
      <span>Registros adicionales</span>
      <strong>+${remainingCount}</strong>
    </div>`;
}

function isRetryableAttendanceError(error){
  if (!error){
    return false;
  }

  const message = typeof error === "string"
    ? error
    : String(error.message || error.name || "");

  return /network|fetch|timeout|429|5\d\d|tempor|limit|quota|rate/i.test(message);
}

function parseWorkerActiveState(activeValue){
  if (typeof activeValue === "boolean"){
    return activeValue;
  }

  if (typeof activeValue === "number"){
    return activeValue > 0;
  }

  if (typeof activeValue === "string"){
    const normalized = activeValue.trim().toLowerCase();
    if (["true", "1", "si", "sí", "yes", "on"].includes(normalized)){
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)){
      return false;
    }
  }

  return Boolean(activeValue);
}

async function executeAttendanceBatch(action, selectedWorkerIds, {
  maxAttempts = 3,
  retryDelayMs = 180
} = {}){
  const idsInOrder = [...selectedWorkerIds];
  const resultsByWorkerId = new Map();
  let pendingIds = [...idsInOrder];

  for (let attempt = 1; attempt <= maxAttempts && pendingIds.length; attempt += 1){
    const waveResults = await Promise.allSettled(
      pendingIds.map(workerId => api(action, { worker: workerId }))
    );

    const retryIds = [];

    waveResults.forEach((result, index) => {
      const workerId = pendingIds[index];

      if (result.status === "fulfilled" && !result.value?.error){
        resultsByWorkerId.set(workerId, result);
        return;
      }

      const isRetryable = result.status === "fulfilled"
        ? isRetryableAttendanceError(result.value?.error)
        : isRetryableAttendanceError(result.reason);

      if (isRetryable && attempt < maxAttempts){
        retryIds.push(workerId);
        return;
      }

      resultsByWorkerId.set(workerId, result);
    });

    pendingIds = retryIds;

    if (pendingIds.length && attempt < maxAttempts){
      await wait(retryDelayMs);
    }
  }

  return idsInOrder.map(workerId =>
    resultsByWorkerId.get(workerId) || {
      status: "rejected",
      reason: new Error("No se pudo completar el marcaje.")
    }
  );
}

async function getUnconfirmedAttendanceWorkerIds(action, workerIds, {
  attempts = 3,
  delayMs = 240
} = {}){
  const expectedActive = action === "checkIn";
  let pendingIds = [...new Set(workerIds.map(workerId => String(workerId)))];

  for (let attempt = 1; attempt <= attempts && pendingIds.length; attempt += 1){
    const workers = await getWorkersData({ force: true });
    const workersById = new Map(
      (Array.isArray(workers) ? workers : [])
        .map(worker => [String(worker.id), parseWorkerActiveState(worker.active)])
    );

    pendingIds = pendingIds.filter(workerId => {
      const hasWorker = workersById.has(workerId);
      if (!hasWorker){
        return true;
      }

      return workersById.get(workerId) !== expectedActive;
    });

    if (pendingIds.length && attempt < attempts){
      await wait(delayMs);
    }
  }

  return pendingIds;
}

async function ensureAttendanceBatchCompletion(action, selectedWorkerIds, settledResults, {
  maxVerifyAttempts = 3,
  verifyDelayMs = 260
} = {}){
  const idsInOrder = selectedWorkerIds.map(workerId => String(workerId));
  const resultsByWorkerId = new Map(
    idsInOrder.map((workerId, index) => [workerId, settledResults[index]])
  );

  let unconfirmedIds = await getUnconfirmedAttendanceWorkerIds(action, idsInOrder, {
    attempts: maxVerifyAttempts,
    delayMs: verifyDelayMs
  });

  if (!unconfirmedIds.length){
    return idsInOrder.map(workerId => resultsByWorkerId.get(workerId));
  }

  setGlobalLoader(true, {
    title: "Verificando marcajes",
    text: `Reintentando ${unconfirmedIds.length} registros no confirmados.`
  });

  const retryResults = await executeAttendanceBatchSequential(action, unconfirmedIds, {
    maxAttempts: 3,
    retryDelayMs: 150,
    onProgress: ({ current, total, workerName }) => {
      setGlobalLoader(true, {
        title: "Reintentando marcajes",
        text: `${current}/${total} - ${workerName}`
      });
    }
  });

  unconfirmedIds.forEach((workerId, index) => {
    resultsByWorkerId.set(String(workerId), retryResults[index]);
  });

  unconfirmedIds = await getUnconfirmedAttendanceWorkerIds(action, unconfirmedIds, {
    attempts: maxVerifyAttempts,
    delayMs: verifyDelayMs
  });

  unconfirmedIds.forEach(workerId => {
    resultsByWorkerId.set(String(workerId), {
      status: "rejected",
      reason: new Error("No se pudo confirmar el marcaje del trabajador.")
    });
  });

  return idsInOrder.map(workerId =>
    resultsByWorkerId.get(workerId) || {
      status: "rejected",
      reason: new Error("No se pudo completar el marcaje.")
    }
  );
}

function buildAttendanceSummary(settledResults, selectedWorkerIds){
  const successResults = [];
  const failedResults = [];

  settledResults.forEach((result, index) => {
    const workerId = selectedWorkerIds[index];
    const fallbackName = getWorkerNameById(workerId);

    if (result.status !== "fulfilled"){
      failedResults.push({ workerId, name: fallbackName });
      return;
    }

    const payload = result.value || {};
    if (payload.error){
      failedResults.push({ workerId, name: payload.name || fallbackName });
      return;
    }

    successResults.push({
      workerId,
      name: payload.name || fallbackName,
      time: payload.time,
      earned: Number(payload.earned || 0)
    });
  });

  return { successResults, failedResults };
}

function applyOptimisticAttendanceState(results, isActive){
  const successfulIds = new Set(
    results
      .filter(result => result?.workerId)
      .map(result => String(result.workerId))
  );

  if (!successfulIds.size){
    return;
  }

  currentWorkers = currentWorkers.map(worker =>
    successfulIds.has(String(worker.id))
      ? normalizeWorker({
          ...worker,
          active: isActive,
          activeStart: isActive ? new Date().toISOString() : ""
        })
      : normalizeWorker(worker)
  );
  renderWorkers(currentWorkers);
}

async function executeAttendanceBatchSequential(action, selectedWorkerIds, {
  maxAttempts = 2,
  retryDelayMs = 90,
  onProgress = null
} = {}){
  const settledResults = [];
  const totalWorkers = selectedWorkerIds.length;

  for (let index = 0; index < totalWorkers; index += 1){
    const workerId = selectedWorkerIds[index];
    const workerName = getWorkerNameById(workerId);

    if (typeof onProgress === "function"){
      onProgress({
        current: index + 1,
        total: totalWorkers,
        workerId,
        workerName
      });
    }

    let finalResult = { status: "rejected", reason: new Error("No se pudo completar el marcaje.") };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1){
      try {
        const payload = await api(action, { worker: workerId });
        finalResult = { status: "fulfilled", value: payload };

        if (!payload?.error){
          break;
        }

        const shouldRetry = isRetryableAttendanceError(payload.error) && attempt < maxAttempts;
        if (!shouldRetry){
          break;
        }
      } catch (error){
        finalResult = { status: "rejected", reason: error };
        const shouldRetry = isRetryableAttendanceError(error) && attempt < maxAttempts;
        if (!shouldRetry){
          break;
        }
      }

      await wait(retryDelayMs);
    }

    settledResults.push(finalResult);
  }

  return settledResults;
}

async function registerAttendance(action){
  const isCheckIn = action === "checkIn";
  const selectedWorkerIds = getSelectedAttendanceWorkerIds();

  if (!selectedWorkerIds.length){
    showPremiumModal({
      icon: "warning",
      title: "Seleccion requerida",
      text: attendanceMode === "multi"
        ? "Selecciona uno o mas trabajadores en el modo multiple."
        : "Selecciona un trabajador para registrar el marcaje."
    });
    return;
  }

  setGlobalLoader(true, {
    title: isCheckIn ? "Registrando entradas" : "Registrando salidas",
    text: isCheckIn
      ? "Estamos marcando la entrada de los trabajadores seleccionados."
      : "Estamos marcando la salida de los trabajadores seleccionados."
  });

  let settledResults = [];
  try {
    if (selectedWorkerIds.length === 1){
      settledResults = await executeAttendanceBatchSequential(action, selectedWorkerIds, {
        maxAttempts: 2,
        retryDelayMs: 90,
        onProgress: ({ current, total, workerName }) => {
          setGlobalLoader(true, {
            title: isCheckIn ? "Registrando entradas" : "Registrando salidas",
            text: `${current}/${total} - ${workerName}`
          });
        }
      });
    } else {
      setGlobalLoader(true, {
        title: isCheckIn ? "Registrando entradas" : "Registrando salidas",
        text: `Procesando ${selectedWorkerIds.length} trabajadores al mismo tiempo.`
      });
      settledResults = await executeAttendanceBatch(action, selectedWorkerIds, {
        maxAttempts: 2,
        retryDelayMs: 120
      });
    }

    settledResults = await ensureAttendanceBatchCompletion(action, selectedWorkerIds, settledResults);
  } finally {
    setGlobalLoader(false);
  }

  const { successResults, failedResults } = buildAttendanceSummary(settledResults, selectedWorkerIds);
  applyOptimisticAttendanceState(successResults, isCheckIn);

  if (!successResults.length){
    showPremiumModal({
      icon: "error",
      title: "No fue posible registrar",
      text: "No se pudo completar el marcaje. Intenta de nuevo."
    });
    return;
  }

  if (successResults.length === 1 && failedResults.length === 0){
    const result = successResults[0];
    showPremiumModal({
      icon: "success",
      title: result.name,
      text: isCheckIn
        ? `Entrada registrada ${formatAttendanceTime(result.time)}`
        : `Salida registrada ${formatAttendanceTime(result.time)} - Ganado ${formatCOP(result.earned)}`
    });
  } else {
    const totalEarned = successResults.reduce((sum, result) => sum + Number(result.earned || 0), 0);

    showPremiumModal({
      icon: failedResults.length ? "warning" : "success",
      title: isCheckIn ? "Entradas registradas" : "Salidas registradas",
      html: `
        <div class="apple-liquidation-summary">
          <div class="apple-liquidation-row"><span>Registros exitosos</span><strong>${successResults.length}</strong></div>
          ${isCheckIn ? "" : `<div class="apple-liquidation-row"><span>Total ganado</span><strong>${formatCOP(totalEarned)}</strong></div>`}
          ${failedResults.length ? `<div class="apple-liquidation-row"><span>Sin registrar</span><strong>${failedResults.length}</strong></div>` : ""}
          ${buildBatchAttendanceRows(successResults)}
        </div>
      `
    });
  }

  const selectedViewerWorker = String(workerSelect.value || "");
  const shouldRefreshLogs = successResults.some(result => String(result.workerId) === selectedViewerWorker);
  void Promise.allSettled([
    refreshLive({ force: true }),
    shouldRefreshLogs ? loadTimeLogs({ showLoader: false, force: true }) : Promise.resolve()
  ]);
}

async function checkIn(){
  await registerAttendance("checkIn");
}

async function checkOut(){
  await registerAttendance("checkOut");
}

async function refreshLive({ force = false } = {}){
  await loadWorkers({ force });
  if (adminUnlocked){
    await loadDashboard({ force });
  }
}

async function saveRate(){
  const rateInput = document.getElementById("hourRate");
  const nextRate = Number(rateInput.value);

  if (!Number.isFinite(nextRate) || nextRate <= 0){
    showPremiumModal({
      icon: "warning",
      title: "Valor invalido",
      text: "Ingresa una tarifa por hora valida antes de guardar."
    });
    return;
  }

  if (currentHourRate !== null && Number(currentHourRate) === nextRate){
    return;
  }

  setGlobalLoader(true, {
    title: "Guardando valor por hora",
    text: "Estamos actualizando la tarifa actual del sistema."
  });

  try {
    await api("setRate", { value: nextRate });
    setCurrentRate(nextRate);
    clearRateInput();
    renderCurrentRate(currentHourRate ?? nextRate);

    showPremiumModal({
      icon: "success",
      title: "Tarifa actualizada",
      text: `La hora quedo guardada en ${formatCOP(currentHourRate ?? nextRate)}`
    });
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadDashboard({ force: true }),
    loadWorkers({ force: true })
  ]);
}

async function loadDashboard({ force = false } = {}){
  const dashboard = await api("getDashboard", {}, {
    cacheMs: FAST_CACHE_MS,
    force
  });

  kpiWorkers.textContent = dashboard.workers;
  kpiHours.textContent = dashboard.hours;
  kpiPay.textContent = formatCOP(dashboard.pay || 0);
  kpiMonth.textContent = dashboard.month || dashboard.liquidations || "Al dia";

  const backendRate = getRateFromDashboard(dashboard);
  if (backendRate !== null){
    setCurrentRate(backendRate);
  } else if (currentHourRate !== null){
    renderCurrentRate(currentHourRate);
  }
}

async function loadCurrentRate(){
  try {
    const settingsResponse = await api("getSettings", {}, {
      cacheMs: READ_CACHE_MS
    });
    const backendRate = extractRateFromSettings(settingsResponse);

    if (backendRate !== null){
      setCurrentRate(backendRate);
      return backendRate;
    }
  } catch (error){
    // Fallback silencioso a dashboard si la accion no existe o falla.
  }

  try {
    const dashboard = await api("getDashboard", {}, {
      cacheMs: FAST_CACHE_MS
    });
    const backendRate = getRateFromDashboard(dashboard);

    if (backendRate !== null){
      setCurrentRate(backendRate);
      return backendRate;
    }
  } catch (error){
    // Si tambien falla, dejamos el estado actual.
  }

  return null;
}

//LIQUIDACIONES INDIRA ENVIO DEL CORREO
function sendLiquidationEmail(worker, liquidation){
  if (!worker?.email) return;

  const form = document.createElement("form");
  form.style.display = "none";

  const data = {
    to_name: worker.name,
    to_email: worker.email,
    telefono: worker.phone || "No registrado",
    horas: liquidation.hours,
    total: liquidation.amount,
    fecha: new Date().toLocaleDateString("es-CO"),
    year: new Date().getFullYear()
  };

  Object.keys(data).forEach(k => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = k;
    input.value = data[k];
    form.appendChild(input);
  });

  document.body.appendChild(form);

  emailjs.sendForm("service_vgavcss", "template_143pfyt", form).then(() => {
      console.log("Correo enviado correctamente");
    })
    .catch(err => {
      console.error("Error enviando correo:", err);
    })
    .finally(() => form.remove());
}


// FUNCION QUE LIQUIDA AL TRABAJADOR 
async function liquidate(workerId){
  const targetWorker = workerId || liquidWorker.value;
  const targetWorkerId = String(targetWorker);

  const targetWorkerData = currentWorkers.find(
    worker => String(worker.id) === targetWorkerId
  );

  setGlobalLoader(true, {
    title: "Liquidando trabajador",
    text: "Estamos calculando las horas y el valor total pendiente."
  });

  try {
    const result = await api("liquidateWorker", { worker: targetWorker });

    setGlobalLoader(false);

    // 🔹 Datos de liquidación
    const liquidationData = {
      hours: result.hours,
      amount: result.amount
    };

    // 🔥 ENVÍO DE CORREO (solo si tiene email)
    if (targetWorkerData?.email) {
      sendLiquidationEmail(targetWorkerData, liquidationData);
    } else {
      console.warn("El trabajador no tiene correo");
    }

    const liquidatedAmount = formatCOP(result.amount);
    const liquidatedHours = formatHoursValue(result.hours);
    const workerName = escapeHTML(
      result.name || targetWorkerData?.name || "Trabajador"
    );

    await showPremiumModal({
      icon: "success",
      title: "Liquidacion completada",
      html: `
        <div class="apple-liquidation-summary">
          <div class="apple-liquidation-row"><span>Trabajador</span><strong>${workerName}</strong></div>
          <div class="apple-liquidation-row"><span>Horas liquidadas</span><strong>${liquidatedHours} h</strong></div>
          <div class="apple-liquidation-row"><span>Total liquidado</span><strong>${liquidatedAmount}</strong></div>
        </div>
      `
    });

    // Reset visual de dias desde la ultima liquidacion.
    visualDaysBaselineByWorker.set(targetWorkerId, Number(targetWorkerData?.days || 0));
    renderWorkers(currentWorkers);

    const isHistorySectionActive = document.getElementById("history")?.classList.contains("active");
    void Promise.allSettled([
      loadDashboard({ force: true }),
      loadWorkers({ force: true }),
      isHistorySectionActive ? loadLiquidationsHistory({ showLoader: false, force: true }) : Promise.resolve()
    ]);

  } catch (error){
    setGlobalLoader(false);

    await showPremiumModal({
      icon: "error",
      title: "No se pudo liquidar",
      text: "Intenta nuevamente en unos segundos."
    });
  }
}

function setTimeLoader(isVisible){
  timeLoader.classList.toggle("visible", isVisible);
  timeLoader.setAttribute("aria-hidden", String(!isVisible));
}

function setGlobalLoader(isVisible, {
  title = "Procesando cambios",
  text = "Espera un momento mientras actualizamos la informacion."
} = {}){
  globalLoaderTitle.textContent = title;
  globalLoaderText.textContent = text;
  globalLoader.classList.toggle("visible", isVisible);
  globalLoader.setAttribute("aria-hidden", String(!isVisible));
}

function setCurrentRate(value){
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0){
    return;
  }

  currentHourRate = numericValue;
  renderCurrentRate(currentHourRate);
}

function normalizeWorker(worker = {}){
  return {
    id: worker.id || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: worker.name || "Sin nombre",
    phone: worker.phone || "",
    email: worker.email || "",
    hourly_rate: getWorkerHourlyRate(worker),
    hours: Number(worker.hours || 0),
    pay: Number(worker.pay || 0),
    days: Number(worker.days || 0),
    active: Boolean(worker.active),
    activeStart: worker.activeStart || "",
    lastLiquidation: worker.lastLiquidation || ""
  };
}

function getRateFromDashboard(dashboard){
  if (!dashboard || typeof dashboard !== "object"){
    return null;
  }

  const directCandidates = [
    dashboard.rate,
    dashboard.hourRate,
    dashboard.hourlyRate,
    dashboard.valorHora,
    dashboard.valorhora,
    dashboard.rateValue,
    dashboard.currentRate,
    dashboard.tarifaHora,
    dashboard.tarifa
  ];

  for (const candidate of directCandidates){
    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue > 0){
      return numericValue;
    }
  }

  for (const [key, value] of Object.entries(dashboard)){
    if (!/rate|hora|tarifa/i.test(key)){
      continue;
    }

    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0){
      return numericValue;
    }
  }

  return null;
}

function extractRateFromSettings(settingsResponse){
  if (!settingsResponse){
    return null;
  }

  if (Array.isArray(settingsResponse)){
    for (const row of settingsResponse){
      const numericValue = extractNumericSettingValue(row);
      if (numericValue !== null){
        return numericValue;
      }
    }
    return null;
  }

  return extractNumericSettingValue(settingsResponse);
}

function extractNumericSettingValue(row){
  if (row === null || row === undefined){
    return null;
  }

  if (typeof row === "number"){
    return Number.isFinite(row) && row > 0 ? row : null;
  }

  if (typeof row === "string"){
    const numericValue = Number(row);
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
  }

  if (typeof row !== "object"){
    return null;
  }

  const sheetName = String(row.sheet || row.sheetName || row.name || row.key || "").toLowerCase();
  const valueCandidates = [
    row.value,
    row.Value,
    row.valor,
    row.rate,
    row.hourRate
  ];

  if (!sheetName || /settings/.test(sheetName)){
    for (const candidate of valueCandidates){
      const numericValue = Number(candidate);
      if (Number.isFinite(numericValue) && numericValue > 0){
        return numericValue;
      }
    }
  }

  return null;
}

function insertOptimisticWorker(result, payload){
  const workerFromApi = result && typeof result === "object"
    ? {
        ...result,
        name: result.name || payload.name,
        phone: result.phone || payload.phone,
        email: result.email || payload.email
      }
    : payload;

  const optimisticWorker = normalizeWorker(workerFromApi);
  const exists = currentWorkers.some(worker =>
    String(worker.id) === String(optimisticWorker.id) ||
    (
      (worker.name || "").trim().toLowerCase() === optimisticWorker.name.trim().toLowerCase() &&
      (worker.phone || "").trim() === optimisticWorker.phone.trim() &&
      (worker.email || "").trim().toLowerCase() === optimisticWorker.email.trim().toLowerCase()
    )
  );

  if (!exists){
    currentWorkers = [optimisticWorker, ...currentWorkers.map(normalizeWorker)];
    renderWorkers(currentWorkers);
  }
}

function removeOptimisticWorker(id){
  currentWorkers = currentWorkers
    .filter(worker => String(worker.id) !== String(id))
    .map(normalizeWorker);
  renderWorkers(currentWorkers);
}

function updateOptimisticWorker(id, updates = {}){
  const workerId = String(id);
  currentWorkers = currentWorkers.map(worker =>
    String(worker.id) === workerId
      ? normalizeWorker({ ...worker, ...updates })
      : normalizeWorker(worker)
  );
  renderWorkers(currentWorkers);
}

function updateSelectedWorkerName(name){
  const selectedOption = workerSelect.options[workerSelect.selectedIndex];
  if (selectedOption && name){
    selectedOption.textContent = name;
  }
}

function updateTimeCaption(text){
  timeTableCaption.textContent = text;
}

function setHistoryLoader(isVisible){
  const historyLoader = document.getElementById("historyLoader");
  if (!historyLoader){
    return;
  }

  historyLoader.classList.toggle("visible", isVisible);
  historyLoader.setAttribute("aria-hidden", String(!isVisible));
}

function getHistoryElements(){
  return {
    historyTableBody: document.getElementById("historyTableBody"),
    historyCaption: document.getElementById("historyCaption"),
    historyWorkerFilter: document.getElementById("historyWorkerFilter"),
    historyDateFilter: document.getElementById("historyDateFilter"),
    historyDateSearch: document.getElementById("historyDateSearch"),
    historyDateSuggestions: document.getElementById("historyDateSuggestions"),
    historyTotalRecords: document.getElementById("historyTotalRecords"),
    historyTotalAmount: document.getElementById("historyTotalAmount")
  };
}

function getFilteredLiquidations(){
  const { historyWorkerFilter, historyDateFilter, historyDateSearch } = getHistoryElements();
  const selectedWorker = historyWorkerFilter?.value || "all";
  const selectedDay = historyDateFilter?.value || "all";
  const dateQuery = normalizeSearchText(historyDateSearch?.value || "");

  return liquidationHistory.filter(record => {
    const workerMatches = selectedWorker === "all" || String(record.workerId) === String(selectedWorker);
    if (!workerMatches){
      return false;
    }

    const dayKey = getLiquidationDayKey(record.liquidation_date);
    const dayMatches = selectedDay === "all" || dayKey === selectedDay;
    if (!dayMatches){
      return false;
    }

    if (!dateQuery){
      return true;
    }

    const searchableDate = normalizeSearchText(formatLiquidationDayLabel(record.liquidation_date));
    const searchableFullDate = normalizeSearchText(formatLiquidationDate(record.liquidation_date));
    return searchableDate.includes(dateQuery) || searchableFullDate.includes(dateQuery);
  });
}

function populateLiquidationWorkerFilter(records = []){
  const { historyWorkerFilter } = getHistoryElements();
  if (!historyWorkerFilter){
    return;
  }

  const previousValue = historyWorkerFilter.value || "all";
  const workersById = new Map();

  currentWorkers.forEach(worker => {
    workersById.set(String(worker.id), worker.name || "Sin nombre");
  });

  records.forEach(record => {
    const workerId = String(record.workerId || "").trim();
    if (!workerId){
      return;
    }

    workersById.set(workerId, record.workerName || workersById.get(workerId) || "Sin nombre");
  });

  const sortedOptions = [...workersById.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "es-CO"));

  historyWorkerFilter.innerHTML = `
    <option value="all">Todos los trabajadores</option>
    ${sortedOptions.map(([id, name]) => `<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join("")}
  `;

  const hasPrevious = previousValue === "all" || sortedOptions.some(([id]) => String(id) === String(previousValue));
  historyWorkerFilter.value = hasPrevious ? previousValue : "all";
}

function populateLiquidationDateFilter(records = []){
  const { historyDateFilter, historyDateSuggestions } = getHistoryElements();
  if (!historyDateFilter){
    return;
  }

  const previousValue = historyDateFilter.value || "all";
  const dayMap = new Map();

  records.forEach(record => {
    const dayKey = getLiquidationDayKey(record.liquidation_date);
    if (!dayKey){
      return;
    }

    dayMap.set(dayKey, formatLiquidationDayLabel(record.liquidation_date));
  });

  const sortedDays = [...dayMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]));

  historyDateFilter.innerHTML = `
    <option value="all">Todas las fechas</option>
    ${sortedDays.map(([key, label]) => `<option value="${escapeHTML(key)}">${escapeHTML(label)}</option>`).join("")}
  `;

  if (historyDateSuggestions){
    historyDateSuggestions.innerHTML = sortedDays
      .map(([, label]) => `<option value="${escapeHTML(label)}"></option>`)
      .join("");
  }

  const hasPrevious = previousValue === "all" || sortedDays.some(([key]) => key === previousValue);
  historyDateFilter.value = hasPrevious ? previousValue : "all";
}

function renderLiquidationsHistory(){
  const {
    historyTableBody,
    historyCaption,
    historyDateFilter,
    historyDateSearch,
    historyTotalRecords,
    historyTotalAmount
  } = getHistoryElements();

  if (!historyTableBody){
    return;
  }

  const filteredRecords = getFilteredLiquidations();
  const selectedWorkerName = document.getElementById("historyWorkerFilter")?.selectedOptions?.[0]?.text || "todos";
  const selectedDateName = historyDateFilter?.selectedOptions?.[0]?.text || "todas las fechas";
  const searchDateText = (historyDateSearch?.value || "").trim();

  if (!filteredRecords.length){
    historyTableBody.innerHTML = `<tr><td colspan="4" class="time-empty">No hay liquidaciones para el filtro seleccionado.</td></tr>`;
    if (historyCaption){
      historyCaption.textContent = `No se encontraron pagos para ${selectedWorkerName.toLowerCase()} en ${selectedDateName.toLowerCase()}${searchDateText ? ` que coincidan con "${searchDateText}"` : ""}.`;
    }
    if (historyTotalRecords){
      historyTotalRecords.textContent = "0";
    }
    if (historyTotalAmount){
      historyTotalAmount.textContent = formatCOP(0);
    }
    return;
  }

  historyTableBody.innerHTML = filteredRecords.map(record => `
    <tr>
      <td>${escapeHTML(record.workerName || "Sin nombre")}</td>
      <td>${formatLiquidationDate(record.liquidation_date)}</td>
      <td>${formatHoursValue(record.hours_paid || 0)} h</td>
      <td><span class="history-paid-chip">${formatCOP(record.amount_paid || 0)}</span></td>
    </tr>
  `).join("");

  const totalAmount = filteredRecords.reduce((acc, record) => acc + Number(record.amount_paid || 0), 0);

  if (historyCaption){
    historyCaption.textContent = `Mostrando ${filteredRecords.length} pagos para ${selectedWorkerName.toLowerCase()} en ${selectedDateName.toLowerCase()}${searchDateText ? ` filtrados por "${searchDateText}"` : ""}.`;
  }
  if (historyTotalRecords){
    historyTotalRecords.textContent = String(filteredRecords.length);
  }
  if (historyTotalAmount){
    historyTotalAmount.textContent = formatCOP(totalAmount);
  }
}

async function loadLiquidationsHistory({ showLoader = true, force = false } = {}){
  const { historyTableBody, historyCaption } = getHistoryElements();
  if (!historyTableBody){
    return [];
  }

  if (showLoader){
    setHistoryLoader(true);
  }

  try {
    const response = await api("getLiquidations", {}, {
      cacheMs: READ_CACHE_MS,
      force: force || showLoader
    });
    liquidationHistory = Array.isArray(response) ? response : [];
    populateLiquidationWorkerFilter(liquidationHistory);
    populateLiquidationDateFilter(liquidationHistory);
    renderLiquidationsHistory();
    return liquidationHistory;
  } catch (error){
    liquidationHistory = [];
    historyTableBody.innerHTML = `<tr><td colspan="4" class="time-empty">No fue posible cargar el historial en este momento.</td></tr>`;
    if (historyCaption){
      historyCaption.textContent = "Hubo un problema al cargar el historial de liquidaciones.";
    }
    return [];
  } finally {
    setHistoryLoader(false);
  }
}

async function refreshLiquidationsHistory(){
  await loadLiquidationsHistory({ showLoader: true });
}

workerSelect.addEventListener("change", () => {
  if (attendanceMode === "multi" && selectedBatchWorkers.size === 0 && workerSelect.value){
    selectedBatchWorkers.add(String(workerSelect.value));
    renderMultiWorkerList(currentWorkers);
  }

  loadTimeLogs({ showLoader: true });
});

const historyWorkerFilter = document.getElementById("historyWorkerFilter");
if (historyWorkerFilter){
  historyWorkerFilter.addEventListener("change", () => {
    renderLiquidationsHistory();
  });
}

const historyDateFilter = document.getElementById("historyDateFilter");
if (historyDateFilter){
  historyDateFilter.addEventListener("change", () => {
    renderLiquidationsHistory();
  });
}

const historyDateSearch = document.getElementById("historyDateSearch");
if (historyDateSearch){
  historyDateSearch.addEventListener("input", () => {
    renderLiquidationsHistory();
  });
}

setInterval(() => {
  document.querySelectorAll(".liveTimer").forEach(el => {
    const start = new Date(el.dataset.start);
    const mins = Math.floor((Date.now() - start) / 60000);
    el.textContent = "Tiempo en turno: " + formatMinutes(mins);
  });
}, 1000);

async function loadTimeLogs({ showLoader = true, force = false } = {}){
  const workerId = workerSelect.value;
  const workerName = workerSelect.options[workerSelect.selectedIndex]?.text || "este trabajador";

  if (!workerId){
    timeLogsTable.innerHTML = `<tr><td colspan="4" class="time-empty">Selecciona un trabajador para ver los marcajes.</td></tr>`;
    updateTimeCaption("Selecciona un trabajador para ver sus registros.");
    setTimeLoader(false);
    return;
  }

  if (showLoader){
    setTimeLoader(true);
  }

  updateTimeCaption(`Mostrando los registros mas recientes de ${workerName}.`);

  try {
    const logs = await api("getTimeLogsByWorker", { worker: workerId }, {
      cacheMs: FAST_CACHE_MS,
      force
    });

    if (!logs.length){
      timeLogsTable.innerHTML = `<tr><td colspan="4" class="time-empty">${workerName} aun no tiene marcajes registrados.</td></tr>`;
      return;
    }

    timeLogsTable.innerHTML = logs.map(log => {
      const inDate = new Date(log.start);
      const outDate = log.end ? new Date(log.end) : null;

      const inFormatted = inDate.toLocaleString("es-CO", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      });

      const outFormatted = outDate
        ? outDate.toLocaleString("es-CO", {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
          })
        : "Pendiente";

      const status = outDate
        ? `<div class="status-out">FUERA DE TURNO</div>`
        : `<span class="active-dot">EN TURNO</span>`;

      return `
        <tr>
          <td>${log.workerName}</td>
          <td><span class="time-chip time-chip-in">${inFormatted}</span></td>
          <td>${outDate ? `<span class="time-chip time-chip-out">${outFormatted}</span>` : `<span class="time-chip time-chip-pending">${outFormatted}</span>`}</td>
          <td>${status}</td>
        </tr>
      `;
    }).join("");
  } catch (error){
    timeLogsTable.innerHTML = `<tr><td colspan="4" class="time-empty">No fue posible cargar los marcajes en este momento.</td></tr>`;
    updateTimeCaption(`Hubo un problema cargando los registros de ${workerName}.`);
  } finally {
    setTimeLoader(false);
  }
}

setAttendanceMode("single");
showSection("time");

setInterval(() => {
  if (adminUnlocked){
    loadDashboard();
  }
}, 30000);
