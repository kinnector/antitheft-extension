# antitheft for JetBrains IDEs

IntelliJ IDEA, PyCharm, WebStorm, GoLand and the other IntelliJ-platform IDEs (2025.1 and later).

- `agent/`: the guard. `Guard` (loaded by the JDK's boot loader) decides with antitheft's salted hashes and
  names the plugin behind a call; `Agent` instruments the JDK's file and process entry points to call it.
  `Agent.plan` says what goes where; `ClassFileRewriter` applies it on JDK 24 and later (java.lang.classfile),
  `AsmRewriter` on JDK 21 to 23 (the ASM inside java.base), so every IDE from 2025.1 is covered.
- `plugin/`: the plugin. `AntitheftService` talks to antitheft (hello, heartbeat, reports, the alerts stream)
  and attaches the agent to the IDE's own JVM; the tool window, the status-bar widget and the notifications
  show what happened.

## Build

No Gradle: the IDE's own JDK and libraries, plus a second JDK for the other rewriter (an IDE on JetBrains
Runtime 25 needs `JDK21`, one on Runtime 21 needs `JDK25`; another IDE's `jbr` folder will do).

    IDE_HOME=/Applications/PyCharm.app/Contents JDK21="/Applications/IntelliJ IDEA CE.app/Contents/jbr" ./build.sh
    IDE_HOME=/opt/pycharm JDK21=/usr/lib/jvm/java-21-openjdk-amd64 ./build.sh       # Linux, the install folder

`build/antitheft.zip` installs from Settings > Plugins > Install Plugin from Disk. `--dev` keeps the
development switches (a test daemon's socket); a release build compiles them out.

## Test

    JDK21=<home> JDK25=<home> test/agent.sh       # the agent on plain JVMs: both rewriters, no IDE

    IDE_HOME=<IDE home> JDK21|JDK25=<home> ./build.sh --dev
    node test/run.mjs <IDE home> [--xvfb]        # --xvfb on Linux without a display

Runs the IDE on a throwaway profile with the plugin, the test stealer plugin (`test/stealer`) and the fake
daemon from `vscode/test/integration`, and checks the guard, the self-check, the reports and the tool window as
it renders (read from the Swing component tree). On macOS over SSH, run it inside the desktop session
(`sudo launchctl asuser $(id -u) sudo -u $USER node test/run.mjs ...`).
