"""pytest: setup.py's data-folder migration (#198) saves the data folder it settled on in the user's settings file
(%APPDATA%\QuChen\settings.json, ~/.config/quchen/settings.json) and can MOVE model files from a folder it finds there.
A test that reaches it must never touch the real file, so the whole session gets its own config home."""
import os
import tempfile

_home = tempfile.mkdtemp(prefix="quchen-pytest-config-")
os.environ["APPDATA"] = _home
os.environ["XDG_CONFIG_HOME"] = _home
# The per-user STATE and DATA folders too (%LOCALAPPDATA%\QuChen: tuning/recheck.json, the engine store, the update records; ~/.local/state, ~/.local/share).
# A test that installs a stub engine marks saved tuning presets for a re-check there: on 2026-10-24 one such run left an entry in the owner's real
# tuning\recheck.json. A test that wants a place of its own still names it (QUCHEN_COMPONENTS_DIR, state_base=...).
os.environ["LOCALAPPDATA"] = _home
os.environ["XDG_STATE_HOME"] = _home
os.environ["XDG_DATA_HOME"] = _home
# The QuChen account gate (serve/authgate.py) is on by default in production.  The suite drives the server directly
# and asserts the pre-login-wall behaviour (page CSP, plain 404s, open control endpoints), so it runs with the gate
# off for the whole session; the gate has its own tests (scripts/auth_gate_selftest.py, scripts/auth_wall_e2e.py).
os.environ["QUCHEN_AUTH_GATE"] = "off"
