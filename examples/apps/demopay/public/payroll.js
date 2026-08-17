const monthInput = document.getElementById('payroll-month');
const createButton = document.getElementById('payroll-create');
const statusEl = document.getElementById('payroll-status');
const errorEl = document.getElementById('payroll-error');
const tbody = document.getElementById('payroll-body');
const logoutLink = document.getElementById('logout-link');

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

monthInput.value = currentMonth();

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.add('visible');
}

function hideError() {
  errorEl.textContent = '';
  errorEl.classList.remove('visible');
}

function renderRows(rows) {
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-testid', 'payroll-row');

    const nameTd = document.createElement('td');
    nameTd.textContent = row.name;

    const grossTd = document.createElement('td');
    grossTd.setAttribute('data-testid', 'payroll-gross');
    grossTd.textContent = row.gross.toFixed(2) + ' zł';

    const netTd = document.createElement('td');
    netTd.setAttribute('data-testid', 'payroll-net');
    netTd.textContent = row.net.toFixed(2) + ' zł';

    tr.appendChild(nameTd);
    tr.appendChild(grossTd);
    tr.appendChild(netTd);
    tbody.appendChild(tr);
  }
}

async function loadPayroll(month) {
  const res = await fetch(`/api/payroll?month=${encodeURIComponent(month)}`);
  if (res.status === 401) {
    window.location.href = '/login';
    return;
  }
  if (res.ok) {
    const data = await res.json();
    renderRows(data.rows);
    if (data.count === 0) {
      setStatus('Brak listy płac dla tego miesiąca.');
    } else {
      setStatus(`Lista płac zawiera ${data.count} pozycji.`);
    }
  }
}

createButton.addEventListener('click', async () => {
  hideError();
  const month = monthInput.value;
  if (!month) {
    showError('Wybierz miesiąc.');
    return;
  }

  setStatus('Tworzenie listy płac… (może potrwać do 8 sekund)');
  createButton.disabled = true;

  try {
    const res = await fetch('/api/payroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }

    if (res.ok) {
      setStatus('Lista płac utworzona.');
      renderRows(data.rows);
      return;
    }

    if (res.status === 503) {
      setStatus(data.error || 'Lista płac w przygotowaniu, spróbuj ponownie.', 'warning');
      errorEl.textContent = data.error || '';
      errorEl.classList.add('visible');
      return;
    }

    showError(data.error || 'Nie udało się utworzyć listy płac');
  } catch (err) {
    showError('Błąd sieci. Spróbuj ponownie.');
  } finally {
    createButton.disabled = false;
  }
});

logoutLink.addEventListener('click', async (event) => {
  event.preventDefault();
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

loadPayroll(currentMonth());
