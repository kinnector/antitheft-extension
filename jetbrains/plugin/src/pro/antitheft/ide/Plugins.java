package pro.antitheft.ide;

import com.intellij.openapi.application.PathManager;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * The plugins people installed, read from the plugins folder itself: each plugin's own `META-INF/plugin.xml` (id,
 * name, version) and `META-INF/pluginIcon.svg`. Every IDE call that hands out a plugin's descriptor by id or lists
 * them (`PluginManagerCore.getPlugin` / `getPlugins`, `PluginManager.getLoadedPlugins`, `PluginUtils`) is
 * `@ApiStatus.Internal`, which JetBrains Marketplace's approval refuses; `PathManager.getPluginsDir()` is public.
 * Bundled plugins never live in that folder, so the list is the third-party ones, enabled or not.
 */
final class Plugins {
    private Plugins() {}

    /** One installed plugin. {@code home} is its folder (or the jar itself, for a plugin that is a single jar). */
    record Info(String id, String name, String version, Path home, Path descriptorJar) {}

    private static final long MAX_XML = 1 << 20;
    private static final int MAX_ICON = 96 * 1024;

    private static volatile List<Info> cached = List.of();
    private static volatile long cachedKey = Long.MIN_VALUE;

    /** Every plugin in the plugins folder, by name. Re-read only when a plugin was added, removed or replaced. */
    static List<Info> installed() {
        File dir;
        try {
            dir = PathManager.getPluginsDir().toFile();
        } catch (Throwable t) {
            return List.of();
        }
        File[] entries = dir.listFiles();
        if (entries == null) return List.of();
        long key = dir.lastModified() * 31 + entries.length;
        for (File f : entries) key = key * 31 + f.lastModified();
        if (key == cachedKey) return cached;
        List<Info> out = new ArrayList<>();
        for (File f : entries) {
            if (f.getName().startsWith(".")) continue; // antitheft-cli's staging and old copies
            Info i = read(f.toPath());
            if (i != null) out.add(i);
        }
        out.sort(Comparator.comparing(i -> i.name().toLowerCase()));
        cached = List.copyOf(out);
        cachedKey = key;
        return cached;
    }

    /** An installed plugin by its id, or null (a bundled one, or one removed since). */
    static Info find(String id) {
        if (id == null) return null;
        for (Info i : installed()) if (id.equals(i.id())) return i;
        return null;
    }

    /** This plugin: by its id in the plugins folder, else from the jar its own classes were loaded from (a plugin
     *  started from another path). IntelliJ's plugin class loader may give its classes no code source. */
    static Info self() {
        Info mine = find(AntitheftService.OWN_ID);
        if (mine != null) return mine;
        try {
            Path jar = Path.of(Plugins.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            Path lib = jar.getParent();
            return lib == null || lib.getParent() == null ? null : read(lib.getParent());
        } catch (Throwable t) {
            return null;
        }
    }

    /** The plugin's own `META-INF/pluginIcon.svg`, at most 96 KiB, or null. Only its own jars are read. */
    static byte[] icon(Info i) {
        if (i == null) return null;
        for (Path jar : jars(i.home())) {
            try (ZipFile z = new ZipFile(jar.toFile())) {
                ZipEntry e = z.getEntry("META-INF/pluginIcon.svg");
                if (e == null) continue;
                try (InputStream in = z.getInputStream(e)) {
                    byte[] svg = in.readNBytes(MAX_ICON + 1);
                    return svg.length > MAX_ICON ? null : svg;
                }
            } catch (Throwable ignored) {
                // an unreadable jar is no icon
            }
        }
        return null;
    }

    /** A plugin folder (`lib/*.jar`) or a single-jar plugin, by the jar that holds `META-INF/plugin.xml`. */
    private static Info read(Path home) {
        for (Path jar : jars(home)) {
            try (ZipFile z = new ZipFile(jar.toFile())) {
                ZipEntry e = z.getEntry("META-INF/plugin.xml");
                if (e == null || e.getSize() > MAX_XML) continue;
                Element root;
                try (InputStream in = z.getInputStream(e)) {
                    root = parser().parse(in).getDocumentElement();
                }
                String name = text(root, "name");
                String id = text(root, "id");
                if (id == null) id = name; // the platform's rule: no <id> means the name is the id
                if (id == null) continue;
                return new Info(id, name != null ? name : id, text(root, "version"), home, jar);
            } catch (Throwable ignored) {
                // not a plugin jar, or a broken one: try the next
            }
        }
        return null;
    }

    private static List<Path> jars(Path home) {
        File f = home.toFile();
        if (f.isFile()) return f.getName().endsWith(".jar") ? List.of(home) : List.of();
        File[] in = home.resolve("lib").toFile().listFiles((d, n) -> n.endsWith(".jar"));
        if (in == null) return List.of();
        List<Path> out = new ArrayList<>();
        for (File j : in) out.add(j.toPath());
        out.sort(Comparator.naturalOrder());
        return out;
    }

    private static DocumentBuilder parser() throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        // a plugin's own file, but still other people's input: no DTDs, no external entities, no includes
        f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        f.setXIncludeAware(false);
        f.setExpandEntityReferences(false);
        f.setNamespaceAware(false);
        return f.newDocumentBuilder();
    }

    /** The text of a direct child element, trimmed, or null. */
    private static String text(Element root, String tag) {
        for (Node n = root.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element el && tag.equals(el.getTagName())) {
                String t = el.getTextContent();
                t = t == null ? "" : t.trim();
                return t.isEmpty() || t.length() > 256 ? null : t;
            }
        }
        return null;
    }
}
