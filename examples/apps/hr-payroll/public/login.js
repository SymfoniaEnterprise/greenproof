const form = document.getElementById('login-form');
const errorDiv = document.getElementById('login-error');

async function handleLogin(e) {
    e.preventDefault();
    errorDiv.textContent = '';
    errorDiv.classList.remove('visible');

    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            window.location.href = '/dashboard';
        } else if (response.status === 401) {
            errorDiv.textContent = 'Nieprawidłowy login lub hasło';
            errorDiv.classList.add('visible');
        } else if (response.status === 403) {
            errorDiv.textContent = 'Konto zablokowane';
            errorDiv.classList.add('visible');
        } else if (response.status === 400) {
            errorDiv.textContent = data.error || 'Błąd formularza';
            errorDiv.classList.add('visible');
        } else {
            errorDiv.textContent = 'Wystąpił błąd. Spróbuj ponownie.';
            errorDiv.classList.add('visible');
        }
    } catch (err) {
        errorDiv.textContent = 'Wystąpił błąd połączenia. Spróbuj ponownie.';
        errorDiv.classList.add('visible');
    }
}

form.addEventListener('submit', handleLogin);

// Check if already logged in
(async function checkSession() {
    try {
        const response = await fetch('/api/session');
        if (response.ok) {
            const data = await response.json();
            if (data.authenticated) {
                window.location.href = '/dashboard';
            }
        }
    } catch (e) {
        // Not logged in
    }
})();
