package pro.antitheft.agent;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.reflect.AccessFlag;
import java.util.List;

/** Applies {@link Agent#plan} with the java.lang.classfile API (JDK 24 and later). Built with a JDK 24+ javac. */
public final class ClassFileRewriter implements Agent.Rewriter {
    @Override
    public byte[] rewrite(byte[] b) {
        ClassFile cf = ClassFile.of();
        ClassModel cm = cf.parse(b);
        String owner = cm.thisClass().asInternalName();
        boolean[] changed = {false};
        byte[] out = cf.transformClass(cm, (clb, ce) -> {
            Agent.Plan plan = ce instanceof MethodModel mm && mm.code().isPresent()
                ? Agent.plan(owner, mm.methodName().stringValue(), mm.methodType().stringValue(), mm.flags().has(AccessFlag.STATIC))
                : null;
            if (plan == null) {
                clb.with(ce);
                return;
            }
            changed[0] = true;
            clb.transformMethod((MethodModel) ce, MethodTransform.transformingCode(new CodeTransform() {
                @Override
                public void atStart(CodeBuilder cb) {
                    emit(cb, plan.atStart());
                }

                @Override
                public void accept(CodeBuilder cb, CodeElement e) {
                    if (!plan.beforeAreturn().isEmpty() && e instanceof ReturnInstruction r && r.opcode() == Opcode.ARETURN) emit(cb, plan.beforeAreturn());
                    cb.with(e);
                }
            }));
        });
        return changed[0] ? out : null;
    }

    static void emit(CodeBuilder cb, List<Agent.Op> ops) {
        for (Agent.Op op : ops) {
            switch (op.kind()) {
                case ALOAD -> cb.aload(op.slot());
                case ILOAD -> cb.iload(op.slot());
                case LDC -> cb.ldc(op.name());
                case DUP -> cb.dup();
                case INVOKESTATIC -> cb.invokestatic(cls(op.owner()), op.name(), MethodTypeDesc.ofDescriptor(op.desc()));
                case INVOKEINTERFACE -> cb.invokeinterface(cls(op.owner()), op.name(), MethodTypeDesc.ofDescriptor(op.desc()));
                case GETSTATIC -> cb.getstatic(cls(op.owner()), op.name(), ClassDesc.ofDescriptor(op.desc()));
            }
        }
    }

    static ClassDesc cls(String internalName) {
        return ClassDesc.ofInternalName(internalName);
    }
}
