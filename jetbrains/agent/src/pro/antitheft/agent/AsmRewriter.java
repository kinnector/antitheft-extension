package pro.antitheft.agent;

import java.util.List;
import jdk.internal.org.objectweb.asm.ClassReader;
import jdk.internal.org.objectweb.asm.ClassVisitor;
import jdk.internal.org.objectweb.asm.ClassWriter;
import jdk.internal.org.objectweb.asm.MethodVisitor;
import jdk.internal.org.objectweb.asm.Opcodes;

/**
 * Applies {@link Agent#plan} with the ASM copy inside java.base, for JDK 21 to 23 (no java.lang.classfile yet;
 * later JDKs no longer carry this copy). Built with a JDK 21 javac and `--add-exports
 * java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED`; the agent exports the package to itself at run time.
 *
 * <p>Injected code leaves the stack as it found it and declares no locals, so the stack map frames stay valid;
 * only the maximum stack size is recomputed.
 */
public final class AsmRewriter implements Agent.Rewriter {
    @Override
    public byte[] rewrite(byte[] b) {
        ClassReader cr = new ClassReader(b);
        ClassWriter cw = new ClassWriter(cr, ClassWriter.COMPUTE_MAXS);
        String owner = cr.getClassName();
        boolean[] changed = {false};
        cr.accept(new ClassVisitor(Opcodes.ASM9, cw) {
            @Override
            public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] exceptions) {
                MethodVisitor mv = super.visitMethod(access, name, desc, sig, exceptions);
                if ((access & (Opcodes.ACC_ABSTRACT | Opcodes.ACC_NATIVE)) != 0) return mv;
                Agent.Plan plan = Agent.plan(owner, name, desc, (access & Opcodes.ACC_STATIC) != 0);
                if (plan == null) return mv;
                changed[0] = true;
                return new MethodVisitor(Opcodes.ASM9, mv) {
                    @Override
                    public void visitCode() {
                        super.visitCode();
                        emit(this, plan.atStart());
                    }

                    @Override
                    public void visitInsn(int opcode) {
                        if (opcode == Opcodes.ARETURN) emit(this, plan.beforeAreturn());
                        super.visitInsn(opcode);
                    }
                };
            }
        }, 0);
        return changed[0] ? cw.toByteArray() : null;
    }

    static void emit(MethodVisitor mv, List<Agent.Op> ops) {
        for (Agent.Op op : ops) {
            switch (op.kind()) {
                case ALOAD -> mv.visitVarInsn(Opcodes.ALOAD, op.slot());
                case ILOAD -> mv.visitVarInsn(Opcodes.ILOAD, op.slot());
                case LDC -> mv.visitLdcInsn(op.name());
                case DUP -> mv.visitInsn(Opcodes.DUP);
                case INVOKESTATIC -> mv.visitMethodInsn(Opcodes.INVOKESTATIC, op.owner(), op.name(), op.desc(), false);
                case INVOKEINTERFACE -> mv.visitMethodInsn(Opcodes.INVOKEINTERFACE, op.owner(), op.name(), op.desc(), true);
                case GETSTATIC -> mv.visitFieldInsn(Opcodes.GETSTATIC, op.owner(), op.name(), op.desc());
            }
        }
    }
}
