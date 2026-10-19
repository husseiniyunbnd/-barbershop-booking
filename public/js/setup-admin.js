
document.getElementById('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const result = document.getElementById('result');
  result.textContent = 'در حال بررسی...';

  try {
    const response = await fetch('/admin/api/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-setup-token': document.getElementById('token').value
      },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    });

    const data = await response.json();
    result.textContent = data.message || data.error?.message ||
      (response.ok ? 'انجام شد.' : 'خطا در ساخت مدیر.');

    if (response.ok) {
      document.getElementById('setup-form').reset();
    }
  } catch {
    result.textContent = 'ارتباط با سرور برقرار نشد؛ وضعیت Deploy را بررسی کن.';
  }
});
