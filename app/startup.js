const title = document.getElementById('title'), detail = document.getElementById('detail'), retry = document.getElementById('retry');
window.workspace.onStartup(status => { title.textContent = status.title; detail.textContent = status.detail; retry.hidden = !status.retry; retry.disabled = false; });
retry.onclick = () => { retry.disabled = true; window.workspace.retryStartup(); };
