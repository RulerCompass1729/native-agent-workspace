// Input shape only; the private carrier still authenticates the exact login.
(function (root) {
  function validActor(value) {
    // Tailscale logins can be usernames, emails or email-like names (@github,
    // @passkey). A URL/path/fragment must never become a remembered account.
    return typeof value === 'string' && value.length > 0 && value.length <= 320 && value === value.trim() &&
      /^[\p{L}\p{N}._+'-]+(?:@[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?)?$/u.test(value);
  }
  const value = { validActor };
  if (typeof module !== 'undefined' && module.exports) module.exports = value;
  else root.nativeWorkspaceMobileIdentity = value;
})(globalThis);
