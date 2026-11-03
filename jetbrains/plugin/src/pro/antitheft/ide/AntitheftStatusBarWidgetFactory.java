package pro.antitheft.ide;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.NlsContexts;
import com.intellij.openapi.wm.StatusBar;
import com.intellij.openapi.wm.StatusBarWidget;
import com.intellij.openapi.wm.StatusBarWidgetFactory;
import com.intellij.util.Consumer;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.awt.Component;
import java.awt.event.MouseEvent;

/** antitheft in the status bar: the standing in a word, alerts counted; a click opens the tool window. */
public final class AntitheftStatusBarWidgetFactory implements StatusBarWidgetFactory {
    @Override
    public @NotNull String getId() {
        return "antitheft";
    }

    @Override
    public @NlsContexts.ConfigurableName @NotNull String getDisplayName() {
        return "antitheft";
    }

    @Override
    public @NotNull StatusBarWidget createWidget(@NotNull Project project) {
        return new Widget();
    }

    static final class Widget implements StatusBarWidget, StatusBarWidget.TextPresentation {
        private static final String WIDGET_ID = "antitheft";
        private StatusBar bar;
        private final Runnable listener = () -> {
            if (bar != null) bar.updateWidget(WIDGET_ID);
        };

        @Override
        public @NotNull String ID() {
            return WIDGET_ID;
        }

        @Override
        public void install(@NotNull StatusBar statusBar) {
            bar = statusBar;
            AntitheftService.get().onChange(listener);
        }

        @Override
        public void dispose() {
            AntitheftService.get().removeListener(listener);
            bar = null;
        }

        @Override
        public @Nullable WidgetPresentation getPresentation() {
            return this;
        }

        @Override
        public @NotNull String getText() {
            AntitheftService s = AntitheftService.get();
            long needs = s.items.stream().filter(Model.Item::needsYou).count();
            return switch (s.standing) {
                case CHECKING -> "antitheft…";
                case NOT_INSTALLED -> "antitheft: one step left";
                case NOT_RUNNING -> "antitheft: not running";
                case PAUSED -> needs > 0 ? "antitheft paused · " + needs + (needs == 1 ? " alert" : " alerts") : "antitheft paused";
                case PROTECTED -> needs > 0 ? needs + (needs == 1 ? " alert" : " alerts") : "antitheft";
            };
        }

        @Override
        public float getAlignment() {
            return Component.CENTER_ALIGNMENT;
        }

        @Override
        public @Nullable String getTooltipText() {
            AntitheftService s = AntitheftService.get();
            return s.items.stream().filter(Model.Item::needsYou).findFirst().map(i -> i.title() + " (click to see it)").orElse("antitheft");
        }

        @Override
        public @Nullable Consumer<MouseEvent> getClickConsumer() {
            // with alerts, straight to them
            return e -> {
                AntitheftService s = AntitheftService.get();
                if (s.items.stream().anyMatch(Model.Item::needsYou)) s.showAlerts();
                ToolWindowOpener.open();
            };
        }
    }
}
