const title = document.getElementById('title'), detail = document.getElementById('detail'), retry = document.getElementById('retry'), data = document.getElementById('data');
window.workspace.onStartup(status => { title.textContent = status.title; detail.textContent = status.detail; retry.hidden = !status.retry; retry.disabled = false; data.hidden = !status.data; });
retry.onclick = () => { retry.disabled = true; window.workspace.retryStartup(); };
data.onclick = () => window.workspace.startupData();
