const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.add('visible');
}

function hideError() {
  errorEl.textContent = '';
  errorEl.classList.remove('visible');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideError();

  const username = document.querySelector('[data-testid="login-username"]').value;
  const password = document.querySelector('[data-testid="login-password"]').value;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      window.location.href = '/employees';
      return;
    }

    const data = await res.json().catch(() => ({}));
    showError(data.error || 'Logowanie nie powiodło się');
  } catch (err) {
    showError('Błąd sieci. Spróbuj ponownie.');
  }
});
