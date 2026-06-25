function togglePassword() {
  const input = document.getElementById('senha');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function doLogin() {
  const email = document.getElementById('email').value.trim();
  const senha = document.getElementById('senha').value;
  const btn = document.getElementById('loginBtn');
  const error = document.getElementById('errorMsg');

  error.classList.remove('visible');

  if (!email || !senha) {
    error.querySelector('svg').nextSibling && true;
    error.lastChild.textContent = ' Preencha e-mail e senha.';
    error.classList.add('visible');
    return;
  }

  btn.classList.add('loading');

  setTimeout(() => {
    btn.classList.remove('loading');
    if (email.includes('@') && senha.length >= 3) {
      window.location.href = 'dashboard.html';
    } else {
      error.classList.add('visible');
    }
  }, 1200);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
