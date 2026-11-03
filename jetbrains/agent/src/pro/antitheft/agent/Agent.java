package pro.antitheft.agent;

import java.io.File;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Loads antitheft's guard into the IDE's own JVM (the plugin attaches it at start) and instruments the JDK's
 * file and process entry points to call it: FileInputStream / RandomAccessFile / FileOutputStream, NIO's
 * channel factories and file copy (Unix and Windows), ProcessBuilder.start (before and after), and the two
 * ways to make a file executable.
 *
 * <p>What is injected where is decided here, once ({@link #plan}). Two rewriters apply it: {@code
 * ClassFileRewriter} on JDK 24 and later (the java.lang.classfile API) and {@code AsmRewriter} on JDK 21 to 23
 * (the ASM copy inside java.base, which later JDKs no longer carry). This class compiles for Java 21.
 */
public final class Agent {
    private Agent() {}

    static final String G = "pro/antitheft/guard/Guard";

    /** JDK classes that open, copy or move by path, whose path parameters are checked. */
    static final List<String> PATH_CLASSES = List.of(
        "sun/nio/fs/UnixChannelFactory", "sun/nio/fs/UnixFileSystem", "sun/nio/fs/UnixCopyFile",
        "sun/nio/fs/WindowsChannelFactory", "sun/nio/fs/WindowsFileCopy");
    static final Set<String> PATH_TYPES = Set.of("Lsun/nio/fs/UnixPath;", "Lsun/nio/fs/WindowsPath;");
    static final Set<String> CLASSES = Set.of(
        "java/io/FileInputStream", "java/io/RandomAccessFile", "java/io/FileOutputStream", "java/lang/ProcessBuilder",
        "java/io/File", "java/nio/file/Files");

    /** One instruction to inject. */
    public record Op(Kind kind, int slot, String owner, String name, String desc) {
        public enum Kind { ALOAD, ILOAD, LDC, INVOKESTATIC, INVOKEINTERFACE, GETSTATIC, DUP }

        static Op aload(int s) { return new Op(Kind.ALOAD, s, null, null, null); }
        static Op iload(int s) { return new Op(Kind.ILOAD, s, null, null, null); }
        static Op ldc(String v) { return new Op(Kind.LDC, 0, null, v, null); }
        static Op guard(String name, String desc) { return new Op(Kind.INVOKESTATIC, 0, G, name, desc); }
        static Op iface(String owner, String name, String desc) { return new Op(Kind.INVOKEINTERFACE, 0, owner, name, desc); }
        static Op getstatic(String owner, String name, String desc) { return new Op(Kind.GETSTATIC, 0, owner, name, desc); }
        static Op dup() { return new Op(Kind.DUP, 0, null, null, null); }
    }

    /** What one method gets: calls at its start, and calls before each `areturn` (the returned value on the stack). */
    public record Plan(List<Op> atStart, List<Op> beforeAreturn) {}

    /** Applies the plans to one class's bytes; null when nothing changed. */
    public interface Rewriter {
        byte[] rewrite(byte[] classBytes) throws Exception;
    }

    static final String FILE_OP = "(Ljava/io/File;Ljava/lang/String;)V";
    static final String OBJ_OP = "(Ljava/lang/Object;Ljava/lang/String;)V";

    /** The plan for one method of an instrumented class, or null to leave it alone. */
    public static Plan plan(String owner, String name, String desc, boolean isStatic) {
        switch (owner) {
            case "java/io/FileInputStream":
                if (name.equals("<init>") && desc.equals("(Ljava/io/File;)V")) return start(Op.aload(1), Op.ldc("FileInputStream"), Op.guard("checkFile", FILE_OP));
                return null;
            case "java/io/RandomAccessFile":
                if (name.equals("<init>") && desc.startsWith("(Ljava/io/File;Ljava/lang/String;")) return start(Op.aload(1), Op.ldc("RandomAccessFile"), Op.guard("checkFile", FILE_OP));
                return null;
            case "java/io/FileOutputStream":
                if (name.equals("<init>") && desc.equals("(Ljava/io/File;Z)V")) {
                    return start(Op.aload(1), Op.ldc("FileOutputStream"), Op.guard("checkFile", FILE_OP), Op.aload(1), Op.guard("writing", "(Ljava/io/File;)V"));
                }
                return null;
            case "java/lang/ProcessBuilder":
                // before: refuse a command naming a vault; after: attribute the launch with its pid
                if (name.equals("start") && desc.equals("()Ljava/lang/Process;")) {
                    return new Plan(List.of(Op.aload(0), Op.guard("checkStart", "(Ljava/lang/Object;)V")),
                        List.of(Op.dup(), Op.aload(0), Op.guard("afterStart", "(Ljava/lang/Process;Ljava/lang/Object;)V")));
                }
                return null;
            case "java/io/File":
                if (name.equals("setExecutable") && desc.equals("(ZZ)Z")) return start(Op.aload(0), Op.iload(1), Op.guard("madeExecutable", "(Ljava/lang/Object;Z)V"));
                return null;
            case "java/nio/file/Files":
                if (name.equals("setPosixFilePermissions") && desc.equals("(Ljava/nio/file/Path;Ljava/util/Set;)Ljava/nio/file/Path;")) {
                    // executable when the set names OWNER_EXECUTE
                    String perm = "java/nio/file/attribute/PosixFilePermission";
                    return start(Op.aload(0), Op.aload(1), Op.getstatic(perm, "OWNER_EXECUTE", "L" + perm + ";"),
                        Op.iface("java/util/Set", "contains", "(Ljava/lang/Object;)Z"), Op.guard("madeExecutable", "(Ljava/lang/Object;Z)V"));
                }
                return null;
            default:
                if (!PATH_CLASSES.contains(owner)) return null;
                List<Integer> slots = pathSlots(owner, name, desc, isStatic);
                if (slots.isEmpty()) return null;
                List<Op> ops = new ArrayList<>();
                for (int s : slots) {
                    ops.add(Op.aload(s));
                    ops.add(Op.ldc("nio " + name));
                    ops.add(Op.guard("checkObj", OBJ_OP));
                }
                return new Plan(ops, List.of());
        }
    }

    static Plan start(Op... ops) {
        return new Plan(List.of(ops), List.of());
    }

    /** The local slots of a method's path parameters (UnixPath / WindowsPath; WindowsChannelFactory's path strings). */
    static List<Integer> pathSlots(String owner, String name, String desc, boolean isStatic) {
        List<Integer> out = new ArrayList<>();
        if (name.equals("<init>") || name.equals("<clinit>")) return out;
        boolean windowsStrings = owner.equals("sun/nio/fs/WindowsChannelFactory");
        int slot = isStatic ? 0 : 1;
        int strings = 0;
        for (String d : params(desc)) {
            if (PATH_TYPES.contains(d)) out.add(slot);
            else if (windowsStrings && d.equals("Ljava/lang/String;") && strings++ < 2) out.add(slot);
            slot += (d.equals("J") || d.equals("D")) ? 2 : 1;
        }
        return out;
    }

    /** A method descriptor's parameter descriptors. */
    static List<String> params(String desc) {
        List<String> out = new ArrayList<>();
        int i = 1;
        while (desc.charAt(i) != ')') {
            int s = i;
            while (desc.charAt(i) == '[') i++;
            i = desc.charAt(i) == 'L' ? desc.indexOf(';', i) + 1 : i + 1;
            out.add(desc.substring(s, i));
        }
        return out;
    }

    public static void premain(String args, Instrumentation inst) {
        install(inst, args);
    }

    public static void agentmain(String args, Instrumentation inst) {
        install(inst, args);
    }

    static void install(Instrumentation inst, String ownId) {
        try {
            Rewriter rewriter = rewriter(inst);
            if (rewriter == null) {
                System.err.println("[antitheft] this JDK can rewrite no classes: the guard is not installed");
                return;
            }
            Class<?> g = Class.forName("pro.antitheft.guard.Guard", true, null);
            inst.redefineModule(Object.class.getModule(), Set.of(g.getModule()), Map.of(), Map.of(), Set.of(), Map.of());
            if (ownId != null && !ownId.isEmpty()) g.getMethod("setOwnId", String.class).invoke(null, ownId);
            inst.addTransformer(new Transformer(rewriter), true);
            List<Class<?>> targets = new ArrayList<>(List.of(java.io.FileInputStream.class, java.io.RandomAccessFile.class, java.io.FileOutputStream.class, ProcessBuilder.class, File.class, java.nio.file.Files.class));
            for (String n : PATH_CLASSES) {
                try {
                    targets.add(Class.forName(n.replace('/', '.')));
                } catch (ClassNotFoundException ignored) {
                    // the other platform's
                }
            }
            inst.retransformClasses(targets.toArray(new Class<?>[0]));
            g.getMethod("markInstalled").invoke(null);
        } catch (Throwable t) {
            System.err.println("[antitheft] the guard could not be installed: " + t);
        }
    }

    /** java.lang.classfile where the JDK has it, else the JDK's internal ASM (exported to this agent first). */
    static Rewriter rewriter(Instrumentation inst) throws Exception {
        if (has("java.lang.classfile.ClassFile")) return load("pro.antitheft.agent.ClassFileRewriter");
        if (has("jdk.internal.org.objectweb.asm.ClassWriter")) {
            Module me = Agent.class.getModule();
            inst.redefineModule(Object.class.getModule(), Set.of(), Map.of("jdk.internal.org.objectweb.asm", Set.of(me)), Map.of(), Set.of(), Map.of());
            return load("pro.antitheft.agent.AsmRewriter");
        }
        return null;
    }

    static boolean has(String cls) {
        try {
            Class.forName(cls, false, null);
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }

    static Rewriter load(String cls) throws Exception {
        return (Rewriter) Class.forName(cls).getDeclaredConstructor().newInstance();
    }

    static final class Transformer implements ClassFileTransformer {
        final Rewriter rewriter;

        Transformer(Rewriter rewriter) {
            this.rewriter = rewriter;
        }

        @Override
        public byte[] transform(Module m, ClassLoader l, String name, Class<?> c, ProtectionDomain pd, byte[] b) {
            if (name == null || !(CLASSES.contains(name) || PATH_CLASSES.contains(name))) return null;
            try {
                return rewriter.rewrite(b);
            } catch (Throwable t) {
                System.err.println("[antitheft] could not instrument " + name + ": " + t);
                return null;
            }
        }
    }
}
