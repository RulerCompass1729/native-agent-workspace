"""Name-only, fail-closed profile preflight at the exec boundary; never emit values."""
import json
import os
import re
import sys


def names(filename, required=False):
    # Deliberately do not deserialize the configuration or credentials. Only
    # these three non-secret names are parsed. Unsupported spelling/layout is
    # blocked, not guessed. Native Codex still validates the complete TOML.
    result = {}
    section = ""
    try:
        stream = open(filename, encoding="utf-8")
    except FileNotFoundError:
        if required:
            raise ValueError("profile-missing")
        return result
    with stream:
        for count, line in enumerate(stream):
            if count > 100000 or len(line) > 65536:
                raise ValueError("profile-layout-unsupported")
            if '"""' in line or "'''" in line:
                raise ValueError("profile-layout-unsupported")
            text = line.strip()
            if not text or text.startswith("#"):
                continue
            if text.startswith("["):
                header = re.fullmatch(r'\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?', text)
                if not header and "model_providers" in text:
                    raise ValueError("profile-layout-unsupported")
                # Other tables (notably quoted project paths) contain no
                # metadata we need. Never parse or retain their values.
                section = header[1] if header else "other"
                if section == "model_providers":
                    raise ValueError("profile-layout-unsupported")
                continue
            if not section and re.match(r'''^(?:model_providers|["'](?:model_providers|model|model_provider)["'])\s*(?:[.=])''', text):
                raise ValueError("profile-layout-unsupported")
            allowed = ("model", "model_provider") if not section else ("env_key",) if section == "model_providers.deepseek" else ()
            for name in allowed:
                if not re.match(r"^" + name + r"\s*=", text):
                    continue
                match = re.fullmatch(name + r'''\s*=\s*["']([A-Za-z0-9_-]+)["']\s*(?:#.*)?''', text)
                if not match or name in result:
                    raise ValueError("profile-layout-unsupported")
                result[name] = match[1]
    return result


def check():
    home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    base = names(os.path.join(home, "config.toml"))
    profile = names(os.path.join(home, "deepseek-pro.config.toml"), True)
    if profile.get("model") != "deepseek-v4-pro" or profile.get("model_provider") != "deepseek":
        raise ValueError("profile-binding-mismatch")
    if profile.get("env_key", base.get("env_key")) != "DEEPSEEK_API_KEY":
        raise ValueError("provider-binding-mismatch")
    # Presence only; do not retain, serialize, hash, measure or print the value.
    return bool(os.environ.get("DEEPSEEK_API_KEY"))


def main():
    try:
        present = check()
        result = {"credentialPresent": present, "ok": present, "reason": None if present else "credential-missing"}
    except (OSError, UnicodeError):
        result = {"credentialPresent": False, "ok": False, "reason": "profile-unreadable"}
    except ValueError as error:
        result = {"credentialPresent": False, "ok": False, "reason": str(error)}
    if len(sys.argv) == 2 and sys.argv[1] == "--check":
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    # fd 3 is a bounded metadata-only pipe. exec keeps this very process's
    # environment; no credential is copied into an argument or receipt.
    with os.fdopen(3, "w") as receipt:
        receipt.write(json.dumps(result))
    if not result["ok"]:
        return 1
    os.execv(sys.argv[1], sys.argv[1:])
    return 1


if __name__ == "__main__":
    sys.exit(main())
