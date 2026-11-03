package pro.antitheft.ide;

import com.intellij.ide.AppLifecycleListener;

import java.util.List;

/** Starts the connection to antitheft as soon as the IDE's frame exists (the guard checks nothing before "protected"). */
public final class Startup implements AppLifecycleListener {
    @Override
    public void appFrameCreated(List<String> commandLineArgs) {
        AntitheftService.get().start();
    }
}
