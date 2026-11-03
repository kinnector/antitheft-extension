package pro.antitheft.ide;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;

/** Brings the antitheft tool window forward in the first open project. */
final class ToolWindowOpener {
    private ToolWindowOpener() {}

    static void open() {
        for (Project p : ProjectManager.getInstance().getOpenProjects()) {
            ToolWindow tw = ToolWindowManager.getInstance(p).getToolWindow("antitheft");
            if (tw != null) {
                tw.show();
                return;
            }
        }
    }
}
