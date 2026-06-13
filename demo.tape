# Renders the README demo gif. Reproduce with: vhs demo.tape
# (brew install vhs)

Output demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1120
Set Height 640
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 38ms

Hide
Type `export PATH="$HOME/.local/bin:$PATH"; unset STORD_AGENT`
Enter
Type `rm -rf /tmp/demo && mkdir -p /tmp/demo/src /tmp/demo/build && cd /tmp/demo`
Enter
Type `echo "console.log('hello')" > src/app.js; echo "API_KEY=sk-live-secret" > .env`
Enter
Type `seq 1 1200 > build/bundle.js; echo ok > build/index.html; git init -q`
Enter
Type `stord enable > /dev/null`
Enter
Type `echo '{"session_id":"a81f02d9","cwd":"/tmp/demo","tool_name":"Read","tool_input":{"file_path":".env"}}' | stord hook post`
Enter
Type `echo "console.log('v2')" > src/app.js`
Enter
Type `echo '{"session_id":"a81f02d9","cwd":"/tmp/demo","tool_name":"Edit","tool_input":{"file_path":"src/app.js"}}' | stord hook post`
Enter
Type `rm -rf build`
Enter
Type `echo '{"workdir":"/tmp/demo","thread_id":"thread-7","tool":"shell","input":{"command":"rm -rf build/"}}' | stord hook post --agent codex`
Enter
Type "clear"
Enter
Show

# 1. The evidence — what your agents read and destroyed, attributed
Sleep 700ms
Type "stord log --reads"
Sleep 400ms
Enter
Sleep 4.5s

# 2. The payoff — one command brings the deleted files back
Type "stord undo last"
Sleep 400ms
Enter
Sleep 3s

Type "ls build/"
Sleep 400ms
Enter
Sleep 2.5s

# 3. The summary — who touched your files (incl. the one that read .env)
Type "stord agents"
Sleep 400ms
Enter
Sleep 5s
