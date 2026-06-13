# Renders the README demo gif. Reproduce with: vhs demo.tape
# (brew install vhs)

Output demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1100
Set Height 620
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

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

Sleep 500ms
Type "stord log --reads"
Sleep 300ms
Enter
Sleep 4s

Type "stord undo last"
Sleep 300ms
Enter
Sleep 3s

Type "ls build/"
Sleep 300ms
Enter
Sleep 3.5s
