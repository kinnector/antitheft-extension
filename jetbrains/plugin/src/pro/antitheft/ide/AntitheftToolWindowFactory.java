package pro.antitheft.ide;

import com.intellij.icons.AllIcons;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.IconLoader;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.JBColor;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBScrollPane;
import com.intellij.ui.components.JBTabbedPane;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.util.ui.JBFont;
import com.intellij.util.ui.JBUI;
import com.intellij.util.ui.UIUtil;
import org.jetbrains.annotations.NotNull;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.Icon;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JPanel;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.GridLayout;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** The antitheft tool window: the standing (a status row with the window's one antitheft mark), the figures, then Alerts, Vaults, Activity and
 *  Plugins, in the IDE's own look. */
public final class AntitheftToolWindowFactory implements ToolWindowFactory, DumbAware {
    static final Icon PROTECTED = IconLoader.getIcon("/icons/state-protected.svg", AntitheftToolWindowFactory.class);
    static final Icon PAUSED = IconLoader.getIcon("/icons/state-paused.svg", AntitheftToolWindowFactory.class);
    static final Icon ALERT = IconLoader.getIcon("/icons/state-alert.svg", AntitheftToolWindowFactory.class);
    static final Icon OFFLINE = IconLoader.getIcon("/icons/state-offline.svg", AntitheftToolWindowFactory.class);

    static final Color BAD = JBColor.namedColor("Label.errorForeground", new JBColor(0xC7222D, 0xFF5261));
    static final Color WARN = JBColor.namedColor("Component.warningFocusColor", new JBColor(0xB27D00, 0xE2B341));
    static final Color OK = new JBColor(0x208A3C, 0x57965C);
    /** Where "Get antitheft" leads while antitheft is not installed. */
    static final String GET_ANTITHEFT = "https://antitheft.pro";

    /** The stripe shows the tool window's id ("antitheft") unless told otherwise; the product's name is Antitheft. */
    @Override
    public void init(@NotNull ToolWindow toolWindow) {
        toolWindow.setStripeTitle("Antitheft");
    }

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        Panel panel = new Panel();
        Content content = ContentFactory.getInstance().createContent(panel, "", false);
        content.setDisposer(panel::detach);
        toolWindow.getContentManager().addContent(content);
    }

    static final class Panel extends JPanel {
        private final AntitheftService s = AntitheftService.get();
        private final Runnable listener = this::requestRender;
        private final JBTabbedPane tabs = new JBTabbedPane();
        /** Each tab's scroll position, kept across a rebuild (and the not-connected page's, under -1). */
        private final Map<Integer, Integer> scrolled = new java.util.HashMap<>();
        private JBScrollPane single;
        private boolean renderQueued;

        Panel() {
            super(new BorderLayout());
            s.onChange(listener);
            render();
        }

        void detach() {
            s.removeListener(listener);
        }

        /** One rebuild for a burst of changes: every vault's icon arriving used to rebuild the window once each. */
        private void requestRender() {
            if (renderQueued) return;
            renderQueued = true;
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater(() -> {
                renderQueued = false;
                render();
            });
        }

        private void render() {
            int tab = tabs.getTabCount() > 0 ? tabs.getSelectedIndex() : 0;
            if (s.alertsNext) {
                s.alertsNext = false;
                tab = 0;
            }
            // the rebuild replaces every scroll pane: remember where each one was, or the list jumps to the top
            for (int i = 0; i < tabs.getTabCount(); i++) {
                if (tabs.getComponentAt(i) instanceof JBScrollPane sp) scrolled.put(i, sp.getVerticalScrollBar().getValue());
            }
            if (single != null) scrolled.put(-1, single.getVerticalScrollBar().getValue());
            single = null;
            removeAll();
            JPanel top = column();
            top.setBorder(JBUI.Borders.empty(10, 12, 6, 12));
            top.add(hero());
            boolean connected = s.standing == AntitheftService.Standing.PROTECTED || s.standing == AntitheftService.Standing.PAUSED;
            if (connected) {
                top.add(Box.createVerticalStrut(JBUI.scale(8)));
                top.add(stats());
            }
            add(top, BorderLayout.NORTH);
            if (connected) {
                tabs.removeAll();
                List<Model.Item> needs = s.items.stream().filter(Model.Item::needsYou).toList();
                tabs.addTab(needs.isEmpty() ? "Alerts" : "Alerts · " + needs.size(), scroll(alerts(needs)));
                tabs.addTab("Vaults", scroll(vaultsTab()));
                tabs.addTab("Activity", scroll(activity()));
                tabs.addTab("Plugins", scroll(plugins()));
                tabs.setSelectedIndex(Math.min(tab, tabs.getTabCount() - 1));
                add(tabs, BorderLayout.CENTER);
            } else {
                single = scroll(notProtected());
                add(single, BorderLayout.CENTER);
            }
            revalidate();
            repaint();
            // after the new panes are laid out (revalidate's own pass runs first)
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater(() -> {
                for (int i = 0; i < tabs.getTabCount(); i++) {
                    Integer y = scrolled.get(i);
                    if (y != null && tabs.getComponentAt(i) instanceof JBScrollPane sp) sp.getVerticalScrollBar().setValue(y);
                }
                Integer y = scrolled.get(-1);
                if (y != null && single != null) single.getVerticalScrollBar().setValue(y);
            });
        }

        private static JPanel column() {
            JPanel p = new JPanel();
            p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));
            p.setOpaque(false);
            return p;
        }

        private static JComponent left(JComponent c) {
            c.setAlignmentX(Component.LEFT_ALIGNMENT);
            return c;
        }

        /** A scrolling page: as wide as the window (text wraps, the right-hand status words stay in view, no sideways
         *  scrolling), content at its own height from the top, a wheel step of a line. */
        private static JBScrollPane scroll(JComponent c) {
            Page page = new Page();
            page.add(c, BorderLayout.NORTH);
            JBScrollPane sp = new JBScrollPane(page, JBScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED, JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
            sp.setBorder(JBUI.Borders.empty());
            sp.getVerticalScrollBar().setUnitIncrement(JBUI.scale(16));
            return sp;
        }

        private static final class Page extends JPanel implements javax.swing.Scrollable {
            Page() {
                super(new BorderLayout());
                setOpaque(false);
            }

            @Override
            public Dimension getPreferredScrollableViewportSize() {
                return getPreferredSize();
            }

            @Override
            public int getScrollableUnitIncrement(java.awt.Rectangle r, int orientation, int direction) {
                return JBUI.scale(16);
            }

            @Override
            public int getScrollableBlockIncrement(java.awt.Rectangle r, int orientation, int direction) {
                return Math.max(JBUI.scale(16), r.height - JBUI.scale(32));
            }

            @Override
            public boolean getScrollableTracksViewportWidth() {
                return true;
            }

            @Override
            public boolean getScrollableTracksViewportHeight() {
                return getParent() instanceof javax.swing.JViewport v && v.getHeight() > getPreferredSize().height;
            }
        }

        /** A tab's head, as the VS Code panel's: its title, one line under it, and the tab's one action on the right. */
        private static JComponent head(String title, String sub, JComponent action) {
            JPanel p = new JPanel(new BorderLayout(JBUI.scale(8), 0));
            p.setOpaque(false);
            p.setBorder(JBUI.Borders.emptyBottom(8));
            JPanel text = column();
            JBLabel t = new JBLabel(title);
            t.setFont(JBFont.label().asBold().biggerOn(2));
            text.add(left(t));
            if (sub != null && !sub.isEmpty()) text.add(left(muted(sub)));
            p.add(text, BorderLayout.CENTER);
            if (action != null) {
                JPanel a = new JPanel(new FlowLayout(FlowLayout.RIGHT, 0, 0));
                a.setOpaque(false);
                a.add(action);
                p.add(a, BorderLayout.EAST);
            }
            return left(p);
        }

        /** A section's eyebrow: small, muted, sentence case. */
        private static JComponent eyebrow(String text) {
            JBLabel l = new JBLabel(text, UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER);
            l.setBorder(JBUI.Borders.empty(12, 0, 4, 0));
            return left(l);
        }

        /** A small muted line, wrapping to the window's width. */
        private static JBLabel muted(String text) {
            JBLabel l = new JBLabel("<html>" + escape(text) + "</html>", UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER);
            l.setAllowAutoWrapping(true);
            return l;
        }

        /** A quiet action, the IDE's own link style: never a row of big buttons under every alert. */
        private static JComponent link(String label, Runnable r) {
            java.awt.event.ActionListener click = e -> r.run();
            com.intellij.ui.components.ActionLink l = new com.intellij.ui.components.ActionLink(label, click);
            l.setFont(JBFont.small());
            return l;
        }

        /** A row that leads somewhere: the hand cursor, a tooltip, the click. */
        private static void clickable(JComponent c, String tip, Runnable r) {
            c.setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR));
            c.setToolTipText(tip);
            c.addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    r.run();
                }
            });
        }

        private record Look(Icon icon, String title, String sub, Color tone, String action) {}

        private Look look() {
            int needs = (int) s.items.stream().filter(Model.Item::needsYou).count();
            Model.Vaults v = s.vaults;
            String guarded = v != null && v.locked() > 0 ? "Only their own apps can open your " + Model.plural(v.locked(), "vault") : "Plugins can't reach your vaults";
            Color muted = UIUtil.getContextHelpForeground();
            return switch (s.standing) {
                case CHECKING -> new Look(OFFLINE, "Checking", "Looking for antitheft on this computer", muted, null);
                case NOT_INSTALLED -> new Look(OFFLINE, "Almost there", "One step left: install antitheft", muted, null);
                case NO_ACCESS -> new Look(OFFLINE, "Almost there", "One step left: continue in antitheft", muted, null);
                case NOT_RUNNING -> new Look(OFFLINE, "Not running", "One step left: start antitheft", WARN, null);
                case UPDATE_ANTITHEFT -> new Look(OFFLINE, "Almost there", "One step left: update antitheft", muted, null);
                case UPDATE_PLUGIN -> new Look(OFFLINE, "Almost there", "One step left: update this plugin", muted, null);
                case PAUSED -> "license".equals(s.pausedBy)
                    ? new Look(PAUSED, "Watching only", "No licence on this computer", WARN, "Get a licence")
                    : new Look(PAUSED, "Paused", "Nothing is blocked until you resume", WARN, "Resume in antitheft");
                case PROTECTED -> needs > 0
                    ? new Look(ALERT, needs == 1 ? "1 alert needs you" : needs + " alerts need you", guarded, BAD, null)
                    : new Look(PROTECTED, "Protected", guarded, OK, null);
            };
        }

        /** The standing as a status row: antitheft's mark (the window's only one), a word, one line, where it blocks. */
        private JComponent hero() {
            Look l = look();
            JPanel p = new JPanel(new BorderLayout(JBUI.scale(12), 0));
            p.setBorder(BorderFactory.createCompoundBorder(JBUI.Borders.customLine(JBColor.border(), 1), JBUI.Borders.empty(12)));
            JBLabel mark = new JBLabel(l.icon());
            mark.setVerticalAlignment(JBLabel.TOP);
            p.add(mark, BorderLayout.WEST);
            JPanel text = column();
            JBLabel t = new JBLabel(l.title());
            t.setFont(JBFont.label().asBold().biggerOn(1));
            text.add(left(t));
            text.add(left(new JBLabel(l.sub(), UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER)));
            // two facts: whether this plugin works, and what antitheft on this computer is doing
            boolean connected = s.standing == AntitheftService.Standing.PROTECTED || s.standing == AntitheftService.Standing.PAUSED;
            boolean partial = s.hooks.values().stream().anyMatch(v -> !"ok".equals(v));
            JPanel chips = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
            chips.setOpaque(false);
            chips.add(!connected ? chip("Plugin waiting", UIUtil.getContextHelpForeground(), "It starts guarding this IDE once antitheft runs.")
                : partial ? chip(s.guardAvailable ? "Plugin partly working" : "Plugin needs a newer IDE", WARN, "Part of the IDE guard is not working.")
                : chip("Plugin working", OK, "A plugin's own reads of your vaults are refused."));
            chips.add(Box.createHorizontalStrut(JBUI.scale(16)));
            chips.add(switch (s.standing) {
                case PROTECTED -> chip("Antitheft installed", OK, s.systemLevel ? "Programs a plugin starts are stopped too." : "This computer can't block at the system level.");
                case PAUSED -> "license".equals(s.pausedBy)
                    ? chip("No licence, nothing blocked", WARN, "antitheft records every read of your vaults and blocks none until this computer has a licence.")
                    : chip("Antitheft paused", WARN, "Nothing is blocked until you resume.");
                case NO_ACCESS -> chip("Antitheft installed", UIUtil.getContextHelpForeground(), "Installed; continue in the antitheft app.");
                case NOT_RUNNING -> chip("Antitheft not running", WARN, "antitheft is installed, but its service is stopped.");
                case UPDATE_ANTITHEFT -> chip("Antitheft out of date", UIUtil.getContextHelpForeground(), "This plugin needs a newer antitheft.");
                case UPDATE_PLUGIN -> chip("Antitheft installed", UIUtil.getContextHelpForeground(), "antitheft has a newer version of this plugin.");
                case CHECKING -> chip("Antitheft starting", UIUtil.getContextHelpForeground(), "Looking for antitheft on this computer.");
                case NOT_INSTALLED -> chip("Antitheft not found", UIUtil.getContextHelpForeground(), "antitheft isn't installed on this computer.");
            });
            // until antitheft answers, the setup steps say where things stand; the chips would only repeat it
            if (connected || s.standing == AntitheftService.Standing.CHECKING) {
                text.add(Box.createVerticalStrut(JBUI.scale(8)));
                text.add(left(chips));
            }
            // no licence is the state people miss: a sentence of its own, and Get a licence as the default button
            boolean noLicence = s.standing == AntitheftService.Standing.PAUSED && "license".equals(s.pausedBy);
            if (noLicence) {
                text.add(Box.createVerticalStrut(JBUI.scale(8)));
                text.add(left(wrap("antitheft sees every read of your vaults but blocks none of them until this computer has a licence.")));
            }
            if (l.action() != null) {
                text.add(Box.createVerticalStrut(JBUI.scale(8)));
                JButton act = button(l.action(), () -> s.openApp("/"));
                if (noLicence) act.putClientProperty(com.intellij.ide.ui.laf.darcula.ui.DarculaButtonUI.DEFAULT_STYLE_KEY, Boolean.TRUE);
                text.add(left(act));
            }
            p.add(text, BorderLayout.CENTER);
            // when alerts need you, the whole row is the way to them
            if (connected && s.items.stream().anyMatch(Model.Item::needsYou)) {
                p.setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR));
                p.setToolTipText("Show the alerts");
                p.addMouseListener(new MouseAdapter() {
                    @Override
                    public void mouseClicked(MouseEvent e) {
                        if (tabs.getTabCount() > 0) tabs.setSelectedIndex(0);
                    }
                });
            }
            // no fixed height: the wrapped sentence and the button under it decide it at the window's width
            return left(p);
        }

        private static JComponent chip(String label, Color tone, String tip) {
            JBLabel l = new JBLabel("<html><span style='color:" + hex(tone) + "'>●</span>&nbsp;" + escape(label) + "</html>", UIUtil.ComponentStyle.SMALL);
            l.setToolTipText(tip);
            return l;
        }

        private static String hex(Color c) {
            return String.format("#%02x%02x%02x", c.getRed(), c.getGreen(), c.getBlue());
        }

        private List<Plugins.Info> userPlugins() {
            List<Plugins.Info> out = new ArrayList<>();
            for (Plugins.Info d : Plugins.installed()) {
                if (!d.id().equals(AntitheftService.OWN_ID)) out.add(d);
            }
            return out;
        }

        /** Three figures: vaults locked, plugins watched, reads denied this week (or blocked here, before a vault list). */
        private JComponent stats() {
            Model.Vaults v = s.vaults;
            boolean paused = s.standing != AntitheftService.Standing.PROTECTED;
            int plugins = userPlugins().size();
            long blockedHere = s.items.stream().filter(i -> i.label().equals("BLOCKED") || i.label().equals("STOPPED")).count();
            JPanel row = new JPanel(new GridLayout(1, 3, JBUI.scale(6), 0));
            row.setOpaque(false);
            if (v != null) row.add(stat(String.valueOf(v.locked()), paused ? (v.locked() == 1 ? "vault watched" : "vaults watched") : v.locked() == 1 ? "vault locked" : "vaults locked", v.locked() > 0 && !paused ? OK : null, 1));
            row.add(stat(String.valueOf(plugins), plugins == 1 ? "plugin watched" : "plugins watched", null, 3));
            // the whole computer's, not this IDE's (every program's refused opens of the vaults): said so in the label
            if (v != null) row.add(stat(Model.compact(v.refused()), paused ? "would be denied on this computer, 7d" : "denied on this computer, 7d", v.refused() > 0 ? BAD : null, -1));
            else row.add(stat(String.valueOf(blockedHere), "blocked here", blockedHere > 0 ? BAD : null, 0));
            row.setMaximumSize(new Dimension(Integer.MAX_VALUE, row.getPreferredSize().height));
            return left(row);
        }

        /** A figure; a click opens its tab (or, -1, the app's Activity). */
        private JComponent stat(String value, String label, Color tone, int tab) {
            JPanel p = column();
            p.setBorder(BorderFactory.createCompoundBorder(JBUI.Borders.customLine(JBColor.border(), 1), JBUI.Borders.empty(6, 8)));
            JBLabel v = new JBLabel(value);
            v.setFont(JBFont.label().biggerOn(5));
            if (tone != null) v.setForeground(tone);
            p.add(left(v));
            // a label may wrap in a narrow tool window ("denied on this computer, 7d"): Para measures it at its width
            Para l = new Para(label, JBFont.small(), UIUtil.getContextHelpForeground());
            p.add(left(l));
            MouseAdapter open = new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    if (tab < 0) s.openApp("/activity");
                    else if (tab < tabs.getTabCount()) tabs.setSelectedIndex(tab);
                }
            };
            for (JComponent c : new JComponent[] {p, l}) {
                c.setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR));
                c.addMouseListener(open);
            }
            return p;
        }

        private JComponent vaultsTab() {
            Model.Vaults v = s.vaults;
            JPanel p = column();
            p.setBorder(JBUI.Borders.empty(10, 12));
            if (v == null || v.total() == 0) {
                p.add(head("Vaults", v == null ? "Reading the vaults on this computer" : "No vaults found yet", null));
                if (v != null) p.add(left(muted("When a wallet, password manager or key appears, antitheft locks it to its own app")));
                return p;
            }
            boolean paused = s.standing != AntitheftService.Standing.PROTECTED;
            // while nothing is blocked a vault is watched, never "locked"
            p.add(head("Vaults", paused ? v.total() + " found, watched only: nothing is blocked" : v.locked() + " of " + v.total() + " locked to their own app",
                link("Open in antitheft", () -> s.openApp("/vaults"))));
            String what = paused ? "" : "No other program can open them, plugins included." + (v.observed() == 1
                ? " The other one is observed: antitheft records every program that opens it."
                : v.observed() > 1 ? " The other " + v.observed() + " are observed: antitheft records every program that opens them." : "");
            if (!what.isEmpty()) p.add(left(muted(what)));
            // the week in figures, the value first as the app's figures read
            String deniedTone = v.refused() > 0 ? hex(BAD) : null;
            String figures = "<b>" + Model.compact(v.allowed()) + "</b> allowed reads&nbsp;&nbsp;·&nbsp;&nbsp;"
                + (deniedTone != null ? "<b style='color:" + deniedTone + "'>" : "<b>") + Model.compact(v.refused()) + "</b> " + (paused ? "would be denied" : "denied")
                + "&nbsp;&nbsp;·&nbsp;&nbsp;7 days" + (v.pending() > 0 ? "&nbsp;&nbsp;·&nbsp;&nbsp;<b style='color:" + hex(WARN) + "'>" + v.pending() + "</b> need your approval" : "");
            JBLabel fig = new JBLabel("<html>" + figures + "</html>", UIUtil.ComponentStyle.SMALL);
            fig.setBorder(JBUI.Borders.emptyTop(6));
            p.add(left(fig));
            for (Model.VaultGroup g : v.groups()) {
                p.add(eyebrow(g.label() + " · " + g.vaults().size()));
                for (Model.Vault x : g.vaults()) p.add(vaultRow(x, g.kind(), paused));
            }
            return p;
        }

        /** One vault, as the VS Code panel's row: its icon, its name and where it lives with the week's reads under it,
         *  its state on the right. A click opens it in antitheft. */
        private JComponent vaultRow(Model.Vault x, String kind, boolean paused) {
            JPanel row = new JPanel(new BorderLayout(JBUI.scale(8), 0));
            row.setOpaque(false);
            row.setBorder(JBUI.Borders.empty(4, 0));
            Icon icon = s.icon("vault:" + x.id() + "|" + (x.category() == null ? "" : x.category()), this::requestRender);
            JBLabel mark = new JBLabel(icon != null ? icon : kind.equals("wallets") ? AllIcons.Ide.Readonly : kind.equals("secrets") ? AllIcons.Nodes.SecurityRole : AllIcons.Nodes.Folder);
            mark.setVerticalAlignment(JBLabel.TOP);
            row.add(mark, BorderLayout.WEST);
            JPanel text = column();
            text.add(left(new JBLabel(x.name())));
            String sub = x.where();
            String week = x.refused() > 0 ? Model.compact(x.allowed()) + " reads · " + Model.compact(x.refused()) + " denied" : x.allowed() > 0 ? Model.compact(x.allowed()) + " reads this week" : "";
            if (!week.isEmpty()) sub = sub.isEmpty() ? week : sub + " · " + week;
            if (!sub.isEmpty()) text.add(left(new JBLabel(sub, UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER)));
            row.add(text, BorderLayout.CENTER);
            boolean locked = x.isLocked();
            String word = paused && locked ? ("license".equals(s.pausedBy) ? "Watching only" : "Paused") : Model.STATUS_LABEL.getOrDefault(x.status(), x.status());
            Color tone = paused && locked ? WARN : "protected".equals(x.status()) ? OK : "partial".equals(x.status()) || "pending".equals(x.status()) ? WARN : UIUtil.getContextHelpForeground();
            JComponent state = chip(word, tone, null);
            ((JBLabel) state).setVerticalAlignment(JBLabel.TOP);
            row.add(state, BorderLayout.EAST);
            clickable(row, "Open in antitheft", () -> s.openApp("/vaults"));
            row.setMaximumSize(new Dimension(Integer.MAX_VALUE, row.getPreferredSize().height));
            return left(row);
        }

        private JComponent notProtected() {
            JPanel p = column();
            p.setBorder(JBUI.Borders.empty(6, 12, 12, 12));
            switch (s.standing) {
                case NOT_INSTALLED, NO_ACCESS, NOT_RUNNING, UPDATE_ANTITHEFT, UPDATE_PLUGIN -> {
                    // a setup that is mostly done, the one step left marked: install antitheft (not installed), log
                    // out and back in (installed, this login may not reach it yet), start it (service stopped). The
                    // IDE switches on by itself after.
                    p.add(Box.createVerticalStrut(JBUI.scale(4)));
                    // each step's mark is the status dot the chips use; one hairline joins them
                    Color muted = UIUtil.getContextHelpForeground();
                    Color now = JBUI.CurrentTheme.Link.Foreground.ENABLED;
                    AntitheftService.Standing st = s.standing;
                    p.add(left(step(OK, OK, "Added to " + s.ideName(), "The plugin is in and ready", false, null)));
                    if (st == AntitheftService.Standing.NOT_INSTALLED) {
                        p.add(left(step(now, JBColor.border(), "Install antitheft",
                            "The app that keeps your wallets and saved passwords yours, on this computer", true,
                            button("Get antitheft", () -> com.intellij.ide.BrowserUtil.browse(GET_ANTITHEFT)))));
                    } else {
                        p.add(left(step(OK, OK, "Install antitheft", st == AntitheftService.Standing.NO_ACCESS ? "Installed and running" : "Installed", false, null)));
                    }
                    if (st == AntitheftService.Standing.NO_ACCESS) {
                        p.add(left(step(now, JBColor.border(), "Continue in antitheft", "Finish setting it up in the antitheft app", true,
                            button("Open antitheft", () -> s.openApp("/")))));
                    }
                    if (st == AntitheftService.Standing.NOT_RUNNING) {
                        p.add(left(step(now, JBColor.border(), "Start antitheft", "Its service is stopped. It starts again with your computer", true,
                            button("Check again", () -> com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit(s::recheck)))));
                    }
                    // antitheft older than this plugin, or newer than it speaks: the app updates itself, and it installs
                    // its own copy of the plugin (Settings > Editors)
                    if (st == AntitheftService.Standing.UPDATE_ANTITHEFT) {
                        p.add(left(step(now, JBColor.border(), "Update antitheft", "This plugin needs a newer antitheft", true,
                            button("Open antitheft", () -> s.openApp("/")))));
                    }
                    if (st == AntitheftService.Standing.UPDATE_PLUGIN) {
                        p.add(left(step(now, JBColor.border(), "Update the plugin", "antitheft has a newer version of it for this IDE", true,
                            button("Open antitheft", () -> s.openApp("/")))));
                    }
                    p.add(left(step(muted, null, "Protected", "This IDE switches on by itself once antitheft runs", false, null)));
                    if (st != AntitheftService.Standing.NOT_INSTALLED) break;
                    // what antitheft is: two short sentences and Learn more (the site), then a real antitheft alert as
                    // a picture. Only what antitheft does: never SSH keys, .env or cloud CLI credentials, which are only
                    // watched.
                    p.add(Box.createVerticalStrut(JBUI.scale(16)));
                    JBLabel what = new JBLabel("What is antitheft?");
                    what.setFont(JBFont.label().asBold().biggerOn(2));
                    p.add(left(what));
                    p.add(Box.createVerticalStrut(JBUI.scale(8)));
                    JComponent line = wrap("Your wallets and passwords open only in their own apps. Anything else that tries, a plugin included, is stopped and named.");
                    line.setForeground(UIUtil.getContextHelpForeground());
                    p.add(left(line));
                    p.add(Box.createVerticalStrut(JBUI.scale(4)));
                    com.intellij.ui.HyperlinkLabel more = new com.intellij.ui.HyperlinkLabel("Learn more");
                    more.addHyperlinkListener(e -> com.intellij.ide.BrowserUtil.browse(GET_ANTITHEFT));
                    p.add(left(more));
                    p.add(Box.createVerticalStrut(JBUI.scale(12)));
                    p.add(left(sampleAlert()));
                }
                default -> { }
            }
            return p;
        }

        /** A sentence that wraps to the width it is given ({@link Para}). */
        private static JComponent wrap(String text) {
            return new Para(text, JBFont.label(), UIUtil.getLabelForeground());
        }

        /** Wrapping text that never asks for more width than it has: its preferred size is the width it was given (or its
         *  parent's) and the height the text takes at that width, measured by the text's own layout. A label instead asked
         *  for one long line, which made the status row wider than the tool window (the figures and tabs slid off its
         *  left edge) and its height that of one line (the Get a licence button below was cut off). */
        private static final class Para extends javax.swing.JTextArea {
            private int laidOutWidth = -1;

            Para(String text, java.awt.Font font, Color fg) {
                super(text);
                setLineWrap(true);
                setWrapStyleWord(true);
                setEditable(false);
                setFocusable(false);
                setOpaque(false);
                setBorder(JBUI.Borders.empty());
                setFont(font);
                setForeground(fg);
                setAlignmentX(Component.LEFT_ALIGNMENT);
                addComponentListener(new java.awt.event.ComponentAdapter() {
                    @Override
                    public void componentResized(java.awt.event.ComponentEvent e) {
                        if (getWidth() != laidOutWidth) {
                            laidOutWidth = getWidth();
                            revalidate();
                        }
                    }
                });
            }

            private int room() {
                if (getWidth() > 0) return getWidth();
                java.awt.Container p = getParent();
                int w = p == null ? 0 : p.getWidth() - p.getInsets().left - p.getInsets().right;
                return w > 0 ? w : JBUI.scale(240);
            }

            @Override
            public Dimension getPreferredSize() {
                int w = room();
                javax.swing.text.View root = getUI().getRootView(this);
                java.awt.Insets in = getInsets();
                root.setSize(Math.max(1, w - in.left - in.right), Integer.MAX_VALUE);
                int h = (int) Math.ceil(root.getPreferredSpan(javax.swing.text.View.Y_AXIS)) + in.top + in.bottom;
                return new Dimension(w, h);
            }

            @Override
            public Dimension getMinimumSize() {
                return new Dimension(JBUI.scale(80), getPreferredSize().height);
            }

            @Override
            public Dimension getMaximumSize() {
                return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
            }
        }

        private static String escape(String s) {
            return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        }

        /** A real antitheft alert as a picture (icons/alert-example.png: the app's own alert card, rendered at 2x for the
         *  README's demo attack), as wide as the window up to its own sharp size; never one rebuilt from the plugin's parts. */
        private static JComponent sampleAlert() {
            java.net.URL url = AntitheftToolWindowFactory.class.getResource("/icons/alert-example.png");
            java.awt.Image img = url == null ? null : new javax.swing.ImageIcon(url).getImage();
            if (img == null || img.getWidth(null) <= 0 || img.getHeight(null) <= 0) return column();
            FitImage pic = new FitImage(img);
            pic.setToolTipText("An antitheft alert: a program a plugin started tried to read Google Chrome's passwords and was stopped");
            return pic;
        }

        /** A picture that fills the width it is given, keeping its shape, never past half its pixel width (it is a 2x
         *  render, so that is as large as it stays sharp). Its height follows its width, so a new width lays it out again. */
        private static final class FitImage extends JComponent {
            private final java.awt.Image img;
            private final int w, h;
            private int laidOutWidth = -1;

            FitImage(java.awt.Image img) {
                this.img = img;
                this.w = img.getWidth(null);
                this.h = img.getHeight(null);
                setAlignmentX(Component.LEFT_ALIGNMENT);
                addComponentListener(new java.awt.event.ComponentAdapter() {
                    @Override
                    public void componentResized(java.awt.event.ComponentEvent e) {
                        if (getWidth() != laidOutWidth) {
                            laidOutWidth = getWidth();
                            revalidate();
                        }
                    }
                });
            }

            private int shownWidth() {
                int max = JBUI.scale(w / 2);
                int room = getWidth() > 0 ? getWidth() : getParent() != null ? getParent().getWidth() - getParent().getInsets().left - getParent().getInsets().right : max;
                return Math.max(JBUI.scale(120), Math.min(max, room));
            }

            @Override
            public Dimension getPreferredSize() {
                int sw = shownWidth();
                return new Dimension(sw, Math.round(h * (sw / (float) w)));
            }

            @Override
            public Dimension getMaximumSize() {
                return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
            }

            @Override
            protected void paintComponent(java.awt.Graphics g) {
                java.awt.Graphics2D g2 = (java.awt.Graphics2D) g.create();
                g2.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                g2.setRenderingHint(java.awt.RenderingHints.KEY_RENDERING, java.awt.RenderingHints.VALUE_RENDER_QUALITY);
                int sw = shownWidth();
                g2.drawImage(img, 0, 0, sw, Math.round(h * (sw / (float) w)), null);
                g2.dispose();
            }
        }

        /** One setup step: the status dot as its mark with the hairline down to the next step (none on the last:
         *  {@code line} null), a title (bold only on the step left), a line, and that step's button. */
        private static JComponent step(Color dot, Color line, String title, String detail, boolean now, JComponent action) {
            JPanel row = new JPanel(new BorderLayout(JBUI.scale(12), 0));
            row.setOpaque(false);
            JBLabel h = new JBLabel(title);
            JComponent mark = new JComponent() {
                @Override
                protected void paintComponent(java.awt.Graphics g) {
                    java.awt.Graphics2D g2 = (java.awt.Graphics2D) g.create();
                    g2.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON);
                    int d = JBUI.scale(8), cx = getWidth() / 2, cy = h.getPreferredSize().height / 2;
                    g2.setColor(dot);
                    g2.fillOval(cx - d / 2, cy - d / 2, d, d);
                    if (line != null) {
                        g2.setColor(line);
                        g2.fillRect(cx, cy + d / 2 + JBUI.scale(4), Math.max(1, JBUI.scale(1)), getHeight());
                    }
                    g2.dispose();
                }
            };
            mark.setPreferredSize(new Dimension(JBUI.scale(12), 0));
            row.add(mark, BorderLayout.WEST);
            JPanel t = column();
            t.setBorder(JBUI.Borders.emptyBottom(16));
            if (now) h.setFont(JBFont.label().asBold());
            else h.setForeground(UIUtil.getContextHelpForeground());
            t.add(left(h));
            // wraps in a narrow window instead of ending in "..."
            t.add(left(muted(detail)));
            if (action != null) {
                t.add(Box.createVerticalStrut(JBUI.scale(8)));
                t.add(left(action));
            }
            row.add(t, BorderLayout.CENTER);
            return row;
        }

        private static JButton button(String label, Runnable r) {
            JButton b = new JButton(label);
            b.addActionListener(e -> r.run());
            return b;
        }

        /** The program's (or the vault's) own icon; null when antitheft has none (yet). */
        /** Who did it: the plugin's own icon when a plugin did, else the program's (its launcher's when it has none). Never
         *  the vault's: that one sits small beside the vault's name under the title ({@link #vaultIconFor}). */
        private Icon iconFor(Model.Item i) {
            Icon icon = null;
            boolean plugin = i.pluginId() != null && !"unknown".equals(i.pluginId());
            if (plugin) icon = s.icon("extension:" + i.pluginId(), this::requestRender);
            if (icon == null && i.programImage() != null) icon = s.icon("actor:" + i.programImage(), this::requestRender);
            if (icon == null && plugin) icon = AllIcons.Nodes.Plugin;
            return icon;
        }

        /** The vault's own icon, drawn small beside its name. */
        private Icon vaultIconFor(Model.Item i) {
            if (i.vaultId() == null) return null;
            Icon icon = s.icon("vault:" + i.vaultId() + "|", this::requestRender);
            return icon == null ? null : com.intellij.util.IconUtil.scale(icon, null, (float) JBUI.scale(14) / Math.max(1, icon.getIconHeight()));
        }

        /** The app's placeholder for a program with no icon: its initial in a dashed box. */
        private static JComponent actorIcon(Icon icon, String name) {
            if (icon != null) return new JBLabel(icon);
            JBLabel l = new JBLabel(name.isEmpty() ? "?" : name.substring(0, 1).toUpperCase(), JBLabel.CENTER);
            l.setFont(JBFont.small().asBold());
            l.setForeground(UIUtil.getContextHelpForeground());
            l.setBorder(BorderFactory.createDashedBorder(JBColor.border(), 3, 2));
            Dimension d = new Dimension(JBUI.scale(20), JBUI.scale(20));
            l.setPreferredSize(d);
            l.setMinimumSize(d);
            return l;
        }

        private static Color sevColor(String sev) {
            return sev == null ? UIUtil.getContextHelpForeground() : switch (sev) {
                case "critical" -> BAD;
                case "warning" -> WARN;
                default -> OK;
            };
        }

        /** One alert or activity line, the VS Code sidebar's shape for a narrow window: the sentence (bold while it needs
         *  you), its target, who did it (their icon and "Claude Code › rm"), then severity and when; an alert's actions as
         *  links, a plugin's own controls as buttons. A click opens it in antitheft. */
        private JComponent card(Model.Item i, boolean withActions) {
            long now = System.currentTimeMillis() / 1000;
            String sev = i.sev();
            JPanel row = new JPanel(new BorderLayout(JBUI.scale(10), 0));
            row.setOpaque(false);
            row.setBorder(BorderFactory.createCompoundBorder(JBUI.Borders.customLine(JBColor.border(), 0, 0, 1, 0), JBUI.Borders.empty(8, 0)));
            String who = i.actorLine() != null ? i.actorLine() : i.pluginName() != null ? i.pluginName() : "";
            String[] parts = who.split(" › ");
            JComponent icon = actorIcon(iconFor(i), parts[parts.length - 1]);
            JPanel iconBox = new JPanel(new BorderLayout());
            iconBox.setOpaque(false);
            iconBox.add(icon, BorderLayout.NORTH);
            row.add(iconBox, BorderLayout.WEST);
            JPanel text = column();
            JBLabel title = new JBLabel("<html>" + escape(i.title()) + "</html>");
            title.setAllowAutoWrapping(true);
            if (i.needsYou()) title.setFont(JBFont.label().asBold());
            text.add(left(title));
            String target = i.target() != null && !i.target().isEmpty() ? i.target() : i.needsYou() ? "" : i.detail();
            if (target != null && !target.isEmpty()) {
                // the vault's icon, small, beside its name
                JBLabel t = muted(target);
                Icon vaultIcon = vaultIconFor(i);
                if (vaultIcon != null) {
                    t.setIcon(vaultIcon);
                    t.setIconTextGap(JBUI.scale(6));
                }
                text.add(left(t));
            }
            if (!who.isEmpty()) text.add(left(muted(who)));
            String word = Model.SEVERITY_LABEL.getOrDefault(sev == null ? "" : sev, Model.word(i.label()));
            JBLabel meta = new JBLabel("<html><span style='color:" + hex(sevColor(sev)) + "'>●&nbsp;" + escape(word) + "</span>&nbsp;&nbsp;" + escape(Model.when(i.at(), now)) + "</html>",
                UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER);
            meta.setBorder(JBUI.Borders.emptyTop(2));
            text.add(left(meta));
            if (withActions) {
                JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
                actions.setOpaque(false);
                actions.setBorder(JBUI.Borders.emptyTop(6));
                boolean own = i.pluginId() != null && !"unknown".equals(i.pluginId());
                if (own) {
                    JButton disable = button("Disable plugin", () -> PluginActions.disable(i.pluginId()));
                    disable.putClientProperty(com.intellij.ide.ui.laf.darcula.ui.DarculaButtonUI.DEFAULT_STYLE_KEY, Boolean.TRUE);
                    actions.add(disable);
                    actions.add(Box.createHorizontalStrut(JBUI.scale(6)));
                    actions.add(button("Uninstall", () -> PluginActions.uninstall(i.pluginId())));
                    actions.add(Box.createHorizontalStrut(JBUI.scale(12)));
                }
                if (i.needsYou()) {
                    actions.add(link("Mark reviewed", () -> s.review(List.of(i))));
                    actions.add(Box.createHorizontalStrut(JBUI.scale(12)));
                }
                if (i.alertId() != null) actions.add(link("Open in antitheft", () -> s.openApp("/alerts?id=" + i.alertId())));
                if (actions.getComponentCount() > 0) text.add(left(actions));
            }
            row.add(text, BorderLayout.CENTER);
            if (i.alertId() != null) clickable(row, "Open in antitheft", () -> s.openApp("/alerts?id=" + i.alertId()));
            return left(row);
        }

        /** A tab's page: its head, then the rows; empty, one grey line under the head (no mark, no second title). */
        private JComponent list(JComponent head, List<JComponent> rows, String emptyText) {
            JPanel p = column();
            p.setBorder(JBUI.Borders.empty(10, 12));
            p.add(head);
            if (rows.isEmpty()) p.add(left(muted(emptyText)));
            for (JComponent r : rows) p.add(r);
            return p;
        }

        private JComponent alerts(List<Model.Item> needs) {
            List<JComponent> rows = new ArrayList<>();
            for (Model.Item i : needs) rows.add(card(i, true));
            String sub = needs.isEmpty() ? "Nothing from this IDE needs you" : Model.plural(needs.size(), "alert") + " from this IDE, " + (needs.size() == 1 ? "it needs" : "they need") + " you";
            return list(head("Alerts", sub, needs.size() > 1 ? link("Mark all reviewed", () -> s.review(needs)) : null), rows,
                "antitheft is watching every plugin in this IDE");
        }

        private JComponent activity() {
            // what was cleared stays out; what still needs you stays until it is reviewed
            long cleared = s.activityClearedAt();
            List<Model.Item> shown = s.items.stream().filter(i -> i.needsYou() || i.at() > cleared).toList();
            List<JComponent> rows = new ArrayList<>();
            for (Model.Item i : shown) rows.add(card(i, false));
            boolean clearable = shown.stream().anyMatch(i -> !i.needsYou());
            return list(head("Activity", Model.plural(shown.size(), "thing") + " plugins did in this IDE", clearable ? link("Clear", s::clearActivity) : null), rows,
                "What plugins do in this IDE shows here");
        }

        private JComponent plugins() {
            Map<String, List<Model.Item>> by = new java.util.HashMap<>();
            for (Model.Item i : s.items) if (i.pluginId() != null) by.computeIfAbsent(i.pluginId(), k -> new ArrayList<>()).add(i);
            List<JComponent> attention = new ArrayList<>();
            List<JComponent> quiet = new ArrayList<>();
            long now = System.currentTimeMillis() / 1000;
            for (Plugins.Info d : Plugins.installed()) {
                String id = d.id();
                if (id.equals(AntitheftService.OWN_ID)) continue;
                List<Model.Item> its = by.getOrDefault(id, List.of());
                if (its.stream().anyMatch(Model.Item::needsYou)) {
                    // what it tried, each line as the alert says it, then its controls
                    JPanel card = column();
                    card.setBorder(BorderFactory.createCompoundBorder(JBUI.Borders.customLine(BAD, 1), JBUI.Borders.empty(8, 10)));
                    card.add(left(pluginHead(d)));
                    for (Model.Item i : its) {
                        String sev = i.sev();
                        String word = Model.SEVERITY_LABEL.getOrDefault(sev == null ? "" : sev, Model.word(i.label()));
                        JBLabel l = new JBLabel("<html><span style='color:" + hex(sevColor(sev)) + "'>●&nbsp;" + escape(word) + "</span>&nbsp;&nbsp;" + escape(i.title())
                            + "&nbsp;&nbsp;<span style='color:" + hex(UIUtil.getContextHelpForeground()) + "'>" + escape(Model.when(i.at(), now)) + "</span></html>", UIUtil.ComponentStyle.SMALL);
                        l.setAllowAutoWrapping(true);
                        l.setBorder(JBUI.Borders.emptyTop(4));
                        card.add(left(l));
                    }
                    JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
                    actions.setOpaque(false);
                    actions.setBorder(JBUI.Borders.emptyTop(8));
                    JButton disable = button("Disable", () -> PluginActions.disable(id));
                    disable.putClientProperty(com.intellij.ide.ui.laf.darcula.ui.DarculaButtonUI.DEFAULT_STYLE_KEY, Boolean.TRUE);
                    actions.add(disable);
                    actions.add(Box.createHorizontalStrut(JBUI.scale(6)));
                    actions.add(button("Uninstall", () -> PluginActions.uninstall(id)));
                    card.add(left(actions));
                    attention.add(left(card));
                } else {
                    long started = its.size();
                    JPanel row = column();
                    row.setBorder(JBUI.Borders.empty(4, 0));
                    row.add(left(pluginHead(d)));
                    JBLabel sub = muted(started > 0 ? "Started " + Model.plural((int) started, "program") + ". None of them touched your vaults" : "Nothing seen");
                    sub.setBorder(JBUI.Borders.emptyLeft(AllIcons.Nodes.Plugin.getIconWidth() + JBUI.scale(8)));
                    row.add(left(sub));
                    quiet.add(left(row));
                }
            }
            List<JComponent> rows = new ArrayList<>();
            if (!attention.isEmpty()) {
                rows.add(eyebrow("Needs your attention"));
                rows.addAll(attention);
            }
            if (!quiet.isEmpty()) {
                rows.add(eyebrow("Nothing to worry about"));
                rows.addAll(quiet);
            }
            int total = attention.size() + quiet.size();
            String sub = Model.plural(total, "plugin") + " installed, " + (attention.isEmpty() ? "none needs your attention" : attention.size() + " " + (attention.size() == 1 ? "needs" : "need") + " your attention");
            return list(head("Plugins", total == 0 ? "No plugins installed" : sub, null), rows, "Only the IDE's own plugins are here");
        }

        /** A plugin's name with its version, the plugin glyph before it. */
        private static JComponent pluginHead(Plugins.Info d) {
            JBLabel name = new JBLabel(d.name(), AllIcons.Nodes.Plugin, JBLabel.LEFT);
            name.setIconTextGap(JBUI.scale(8));
            JPanel p = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
            p.setOpaque(false);
            p.add(name);
            if (d.version() != null) {
                JBLabel v = new JBLabel("  " + d.version(), UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER);
                p.add(v);
            }
            return p;
        }
    }

}
