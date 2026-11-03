package pro.antitheft.ide;

import com.intellij.icons.AllIcons;
import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
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
        private final Runnable listener = this::render;
        private final JBTabbedPane tabs = new JBTabbedPane();

        Panel() {
            super(new BorderLayout());
            s.onChange(listener);
            render();
        }

        void detach() {
            s.removeListener(listener);
        }

        private void render() {
            int tab = tabs.getTabCount() > 0 ? tabs.getSelectedIndex() : 0;
            if (s.alertsNext) {
                s.alertsNext = false;
                tab = 0;
            }
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
                add(scroll(notProtected()), BorderLayout.CENTER);
            }
            revalidate();
            repaint();
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

        private static JBScrollPane scroll(JComponent c) {
            JPanel wrap = new JPanel(new BorderLayout());
            wrap.add(c, BorderLayout.NORTH);
            JBScrollPane sp = new JBScrollPane(wrap);
            sp.setBorder(JBUI.Borders.empty());
            return sp;
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
                case NOT_RUNNING -> new Look(OFFLINE, "Not running", "antitheft's service is stopped", WARN, null);
                case PAUSED -> "license".equals(s.pausedBy)
                    ? new Look(PAUSED, "Watching only", "Nothing is blocked without a licence", WARN, "Get a licence")
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
                case PROTECTED -> chip("antitheft installed", OK, s.systemLevel ? "Programs a plugin starts are stopped too." : "This computer can't block at the system level.");
                case PAUSED -> chip("antitheft paused", WARN, "license".equals(s.pausedBy) ? "Watching only: no licence on this computer." : "Nothing is blocked until you resume.");
                case NOT_RUNNING -> chip("antitheft not running", WARN, "antitheft is installed, but its service is stopped.");
                case CHECKING -> chip("antitheft starting", UIUtil.getContextHelpForeground(), "Looking for antitheft on this computer.");
                case NOT_INSTALLED -> chip("antitheft not found", UIUtil.getContextHelpForeground(), "antitheft isn't installed on this computer.");
            });
            // before antitheft is installed the setup steps say where things stand; the chips would only repeat it
            if (s.standing != AntitheftService.Standing.NOT_INSTALLED) {
                text.add(Box.createVerticalStrut(JBUI.scale(8)));
                text.add(left(chips));
            }
            if (l.action() != null) {
                text.add(Box.createVerticalStrut(JBUI.scale(8)));
                text.add(left(button(l.action(), () -> s.openApp("/"))));
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
            p.setMaximumSize(new Dimension(Integer.MAX_VALUE, p.getPreferredSize().height));
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

        private List<IdeaPluginDescriptor> userPlugins() {
            List<IdeaPluginDescriptor> out = new ArrayList<>();
            for (IdeaPluginDescriptor d : PluginManagerCore.getPlugins()) {
                if (!d.isBundled() && !d.getPluginId().getIdString().equals(AntitheftService.OWN_ID)) out.add(d);
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
            if (v != null) row.add(stat(String.valueOf(v.locked()), v.locked() == 1 ? "vault locked" : "vaults locked", v.locked() > 0 ? OK : null, 1));
            row.add(stat(String.valueOf(plugins), plugins == 1 ? "plugin watched" : "plugins watched", null, 3));
            if (v != null) row.add(stat(Model.compact(v.refused()), paused ? "would be denied, 7d" : "denied reads, 7d", v.refused() > 0 ? BAD : null, -1));
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
            p.add(left(new JBLabel(label, UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER)));
            p.setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR));
            p.addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    if (tab < 0) s.openApp("/activity");
                    else if (tab < tabs.getTabCount()) tabs.setSelectedIndex(tab);
                }
            });
            return p;
        }

        private JComponent vaultsTab() {
            Model.Vaults v = s.vaults;
            JPanel p = column();
            p.setBorder(JBUI.Borders.empty(8, 12));
            if (v == null || v.total() == 0) {
                JBLabel t = new JBLabel(v == null ? "Vaults are loading" : "No vaults found yet", PROTECTED, JBLabel.LEFT);
                t.setFont(JBFont.label().asBold());
                p.add(left(t));
                p.add(left(new JBLabel(v == null ? "antitheft is listing the vaults on this computer." : "When a wallet, password manager or key appears, antitheft locks it to its own app.", UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER)));
                return p;
            }
            boolean paused = s.standing != AntitheftService.Standing.PROTECTED;
            JBLabel head = new JBLabel(v.locked() + " of " + v.total() + " vaults are locked to their own app");
            head.setFont(JBFont.label().asBold().biggerOn(2));
            p.add(left(head));
            p.add(left(wrap("No other program can open them, plugins included." + (v.observed() == 1
                ? " The other one is observed: antitheft records every program that opens it."
                : v.observed() > 1 ? " The other " + v.observed() + " are observed: antitheft records every program that opens them." : ""))));
            String figures = Model.compact(v.allowed()) + (v.allowed() == 1 ? " allowed read" : " allowed reads") + "  ·  " + Model.compact(v.refused())
                + (paused ? " would be denied" : v.refused() == 1 ? " denied read" : " denied reads") + "  ·  last 7 days"
                + (v.pending() > 0 ? "  ·  " + v.pending() + " need your approval" : "");
            p.add(left(new JBLabel(figures, UIUtil.ComponentStyle.SMALL)));
            p.add(Box.createVerticalStrut(JBUI.scale(4)));
            p.add(left(button("Open in antitheft", () -> s.openApp("/vaults"))));
            for (Model.VaultGroup g : v.groups()) {
                p.add(Box.createVerticalStrut(JBUI.scale(12)));
                JBLabel eyebrow = new JBLabel(g.label() + "  ·  " + g.vaults().size(), UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER);
                eyebrow.setFont(eyebrow.getFont().deriveFont(java.awt.Font.BOLD));
                p.add(left(eyebrow));
                p.add(Box.createVerticalStrut(JBUI.scale(4)));
                for (Model.Vault x : g.vaults()) p.add(vaultRow(x, g.kind(), paused));
            }
            return p;
        }

        private JComponent vaultRow(Model.Vault x, String kind, boolean paused) {
            JPanel row = new JPanel(new BorderLayout(JBUI.scale(8), 0));
            row.setOpaque(false);
            row.setBorder(JBUI.Borders.empty(3, 0));
            Icon icon = s.icon("vault:" + x.id() + "|" + (x.category() == null ? "" : x.category()), this::render);
            row.add(new JBLabel(icon != null ? icon : kind.equals("wallets") ? AllIcons.Ide.Readonly : kind.equals("secrets") ? AllIcons.Nodes.SecurityRole : AllIcons.Nodes.Folder), BorderLayout.WEST);
            JPanel text = column();
            JBLabel n = new JBLabel(x.name());
            n.setFont(JBFont.label().asBold());
            text.add(left(n));
            String sub = x.where();
            String week = x.refused() > 0 ? Model.compact(x.allowed()) + " reads · " + Model.compact(x.refused()) + " denied" : x.allowed() > 0 ? Model.compact(x.allowed()) + " reads this week" : "";
            if (!week.isEmpty()) sub = sub.isEmpty() ? week : sub + "  ·  " + week;
            if (!sub.isEmpty()) text.add(left(new JBLabel(sub, UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER)));
            row.add(text, BorderLayout.CENTER);
            boolean locked = x.isLocked();
            String word = paused && locked ? ("license".equals(s.pausedBy) ? "Watching only" : "Paused") : Model.STATUS_LABEL.getOrDefault(x.status(), x.status());
            Color tone = paused && locked ? WARN : "protected".equals(x.status()) ? OK : "partial".equals(x.status()) || "pending".equals(x.status()) ? WARN : UIUtil.getContextHelpForeground();
            row.add(chip(word, tone, null), BorderLayout.EAST);
            row.setMaximumSize(new Dimension(Integer.MAX_VALUE, row.getPreferredSize().height));
            return left(row);
        }

        private JComponent notProtected() {
            JPanel p = column();
            p.setBorder(JBUI.Borders.empty(6, 12, 12, 12));
            switch (s.standing) {
                case NOT_RUNNING -> {
                    p.add(left(new JBLabel("Start antitheft, and this IDE is guarded again.")));
                    p.add(left(button("Check again", () -> com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit(s::recheck))));
                }
                case NOT_INSTALLED -> {
                    // a setup that is mostly done: the plugin is in, antitheft is the one step left, the IDE
                    // switches on by itself once it runs
                    p.add(Box.createVerticalStrut(JBUI.scale(4)));
                    // each step's mark is the status dot the chips use; one hairline joins them
                    Color muted = UIUtil.getContextHelpForeground();
                    p.add(left(step(OK, OK, "Added to " + s.ideName(), "The plugin is in and ready", false, null)));
                    p.add(left(step(JBUI.CurrentTheme.Link.Foreground.ENABLED, JBColor.border(), "Install antitheft",
                        "The app that keeps your wallets and saved passwords yours, on this computer", true,
                        button("Get antitheft", () -> com.intellij.ide.BrowserUtil.browse(GET_ANTITHEFT)))));
                    p.add(left(step(muted, null, "Protected", "This IDE switches on by itself once antitheft runs", false, null)));
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

        private static JComponent wrap(String text) {
            JBLabel l = new JBLabel("<html><body style='width: 260px'>" + escape(text) + "</body></html>");
            l.setAllowAutoWrapping(true);
            return l;
        }

        private static String escape(String s) {
            return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        }

        /** A real antitheft alert as a picture (icons/alert-example.png: the app's own alert card, rendered at 2x for the
         *  README's demo attack), 300 px wide; never one rebuilt from the plugin's parts. */
        private static JComponent sampleAlert() {
            JPanel p = column();
            java.net.URL url = AntitheftToolWindowFactory.class.getResource("/icons/alert-example.png");
            if (url != null) {
                java.awt.Image img = new javax.swing.ImageIcon(url).getImage();
                int w = img.getWidth(null), h = img.getHeight(null);
                if (w > 0 && h > 0) {
                    int width = JBUI.scale(300);
                    JBLabel pic = new JBLabel(new javax.swing.ImageIcon(img.getScaledInstance(width, Math.round(h * (width / (float) w)), java.awt.Image.SCALE_SMOOTH)));
                    pic.setToolTipText("An antitheft alert: a program a plugin started tried to read Google Chrome's passwords and was stopped");
                    p.add(left(pic));
                }
            }
            return p;
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
            t.add(left(new JBLabel(detail, UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER)));
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
        private Icon iconFor(Model.Item i) {
            Icon icon = null;
            if (i.programImage() != null) icon = s.icon("actor:" + i.programImage(), this::render);
            if (icon == null && i.vaultId() != null) icon = s.icon("vault:" + i.vaultId() + "|", this::render);
            if (icon == null && i.pluginId() != null && i.programImage() == null) icon = AllIcons.Nodes.Plugin;
            return icon;
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

        private static Color toneColor(Model.Tone t) {
            return switch (t) {
                case CRITICAL -> BAD;
                case WARNING -> WARN;
                default -> UIUtil.getContextHelpForeground();
            };
        }

        /** One alert or activity line as the app's Alerts table draws it: severity (a dot and a word), the sentence with
         *  its target, who did it (icon and "Claude Code › rm"), when; then its controls. */
        private JComponent card(Model.Item i, boolean withActions) {
            long now = System.currentTimeMillis() / 1000;
            String sev = i.sev();
            JPanel row = new JPanel(new BorderLayout(JBUI.scale(12), JBUI.scale(4)));
            row.setBorder(BorderFactory.createCompoundBorder(JBUI.Borders.customLine(JBColor.border(), 0, 0, 1, 0), JBUI.Borders.empty(8, 4)));
            JBLabel severity = new JBLabel(sev != null ? "<html><span style='color:" + hex(sevColor(sev)) + "'>●</span>&nbsp;" + escape(Model.SEVERITY_LABEL.get(sev)) + "</html>" : Model.word(i.label()), UIUtil.ComponentStyle.SMALL);
            severity.setForeground(sevColor(sev));
            severity.setVerticalAlignment(JBLabel.TOP);
            severity.setPreferredSize(new Dimension(JBUI.scale(84), severity.getPreferredSize().height));
            row.add(severity, BorderLayout.WEST);
            JPanel text = column();
            JBLabel title = new JBLabel(i.title());
            if (i.needsYou()) title.setFont(JBFont.label().asBold());
            text.add(left(title));
            String target = i.target() != null && !i.target().isEmpty() ? i.target() : i.needsYou() ? "" : i.detail();
            if (!target.isEmpty()) text.add(left(new JBLabel(target, UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER)));
            String who = i.actorLine() != null ? i.actorLine() : i.pluginName();
            if (who != null && !who.isEmpty()) {
                JPanel actor = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0));
                actor.setOpaque(false);
                String[] parts = who.split(" › ");
                actor.add(actorIcon(iconFor(i), parts[parts.length - 1]));
                actor.add(new JBLabel(who + "  ·  " + Model.when(i.at(), now), UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER));
                text.add(Box.createVerticalStrut(JBUI.scale(4)));
                text.add(left(actor));
            }
            if (withActions) {
                JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0));
                actions.setOpaque(false);
                if (i.pluginId() != null && !"unknown".equals(i.pluginId())) {
                    actions.add(button("Disable plugin", () -> PluginActions.disable(i.pluginId())));
                    actions.add(button("Uninstall", () -> PluginActions.uninstall(i.pluginId())));
                }
                if (i.needsYou()) actions.add(button("Mark reviewed", () -> s.review(List.of(i))));
                if (i.alertId() != null) actions.add(button("Open in antitheft", () -> s.openApp("/alerts?id=" + i.alertId())));
                text.add(Box.createVerticalStrut(JBUI.scale(6)));
                text.add(left(actions));
            }
            row.add(text, BorderLayout.CENTER);
            row.setMaximumSize(new Dimension(Integer.MAX_VALUE, row.getPreferredSize().height));
            return left(row);
        }

        private JComponent list(List<JComponent> rows, String emptyTitle, String emptyText) {
            JPanel p = column();
            p.setBorder(JBUI.Borders.empty(8, 12));
            if (rows.isEmpty()) {
                JBLabel t = new JBLabel(emptyTitle, PROTECTED, JBLabel.LEFT);
                t.setFont(JBFont.label().asBold());
                p.add(left(t));
                p.add(left(new JBLabel(emptyText, UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER)));
            }
            for (JComponent r : rows) {
                p.add(r);
                p.add(Box.createVerticalStrut(JBUI.scale(8)));
            }
            return p;
        }

        private JComponent alerts(List<Model.Item> needs) {
            List<JComponent> rows = new ArrayList<>();
            if (needs.size() > 1) {
                JPanel bar = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
                bar.setOpaque(false);
                bar.add(button("Mark all reviewed", () -> s.review(needs)));
                bar.setMaximumSize(new Dimension(Integer.MAX_VALUE, bar.getPreferredSize().height));
                rows.add(left(bar));
            }
            for (Model.Item i : needs) rows.add(card(i, true));
            return list(rows, "Nothing needs you", "antitheft is watching every plugin in this IDE.");
        }

        private JComponent activity() {
            // what was cleared stays out; what still needs you stays until it is reviewed
            long cleared = s.activityClearedAt();
            List<Model.Item> shown = s.items.stream().filter(i -> i.needsYou() || i.at() > cleared).toList();
            List<JComponent> rows = new ArrayList<>();
            if (shown.stream().anyMatch(i -> !i.needsYou())) {
                JPanel bar = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
                bar.setOpaque(false);
                bar.add(button("Clear", s::clearActivity));
                bar.setMaximumSize(new Dimension(Integer.MAX_VALUE, bar.getPreferredSize().height));
                rows.add(left(bar));
            }
            for (Model.Item i : shown) rows.add(card(i, false));
            return list(rows, "Nothing new", "What plugins do in this IDE shows here.");
        }

        private JComponent plugins() {
            Map<String, List<Model.Item>> by = new java.util.HashMap<>();
            for (Model.Item i : s.items) if (i.pluginId() != null) by.computeIfAbsent(i.pluginId(), k -> new ArrayList<>()).add(i);
            List<JComponent> rows = new ArrayList<>();
            List<IdeaPluginDescriptor> quiet = new ArrayList<>();
            for (IdeaPluginDescriptor d : PluginManagerCore.getPlugins()) {
                String id = d.getPluginId().getIdString();
                if (id.equals(AntitheftService.OWN_ID) || d.isBundled()) continue;
                List<Model.Item> its = by.getOrDefault(id, List.of());
                if (its.stream().anyMatch(Model.Item::needsYou)) {
                    JPanel card = column();
                    card.setBorder(BorderFactory.createCompoundBorder(JBUI.Borders.customLine(BAD, 1), JBUI.Borders.empty(8, 10)));
                    JBLabel name = new JBLabel(d.getName() + "  " + d.getVersion(), AllIcons.Nodes.Plugin, JBLabel.LEFT);
                    name.setFont(JBFont.label().asBold());
                    card.add(left(name));
                    for (Model.Item i : its) {
                        JBLabel l = new JBLabel(Model.word(i.label()) + "   " + i.title(), UIUtil.ComponentStyle.SMALL);
                        l.setForeground(toneColor(i.tone()));
                        card.add(left(l));
                    }
                    JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(6), JBUI.scale(4)));
                    actions.setOpaque(false);
                    actions.add(button("Disable", () -> PluginActions.disable(id)));
                    actions.add(button("Uninstall", () -> PluginActions.uninstall(id)));
                    card.add(left(actions));
                    card.setMaximumSize(new Dimension(Integer.MAX_VALUE, card.getPreferredSize().height));
                    rows.add(0, left(card));
                } else {
                    quiet.add(d);
                }
            }
            for (IdeaPluginDescriptor d : quiet) {
                long started = by.getOrDefault(d.getPluginId().getIdString(), List.of()).size();
                JPanel row = new JPanel(new BorderLayout(JBUI.scale(8), 0));
                row.setOpaque(false);
                row.add(new JBLabel(d.getName(), AllIcons.Nodes.Plugin, JBLabel.LEFT), BorderLayout.WEST);
                row.add(new JBLabel(started > 0 ? "Started " + started + " programs. None touched your vaults." : "Nothing seen.", UIUtil.ComponentStyle.SMALL, UIUtil.FontColor.BRIGHTER), BorderLayout.CENTER);
                row.setMaximumSize(new Dimension(Integer.MAX_VALUE, row.getPreferredSize().height));
                rows.add(left(row));
            }
            return list(rows, "No plugins installed", "Only the IDE's own plugins are here.");
        }
    }

}
