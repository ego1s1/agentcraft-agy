package dev.agentcraft.client.ui;

import dev.agentcraft.AgentCraft;
import java.lang.reflect.Method;
import net.fabricmc.loader.api.FabricLoader;

/**
 * Shader-pack compatibility for the mod's custom world pipelines
 * ({@code world_ui_solid}, {@code displays_solid}).
 *
 * <p>Shader pipelines (Iris and forks like Sulkan) only know vanilla programs:
 * our custom ones hit their fallback path and render as garbage (flat magenta
 * slabs, stretched quads; see the "Missing program ... in override list"
 * errors). When shaders are active the world UI must use vanilla pipelines
 * instead: unshaded but correct.
 *
 * <p>No hard dependency on any shader mod: everything here is reflection plus
 * {@code FabricLoader#isModLoaded}, evaluated per call so toggling a pack
 * mid-session takes effect immediately. Detection failure fails open (custom
 * pipelines, today's behaviour) with a warning.
 */
public final class ShaderCompat {
	private ShaderCompat() {
	}

	private static volatile boolean irisProbed;
	private static volatile boolean irisUsable;
	private static volatile boolean irisWarned;

	/**
	 * True when a shader pack is currently transforming world rendering and our
	 * custom pipelines are therefore unsafe to use.
	 */
	public static boolean shadersActive() {
		// Iris: accurate, only true while a pack is actually enabled.
		if (FabricLoader.getInstance().isModLoaded("iris")) {
			Boolean active = irisPackInUse();
			if (active != null) {
				return active;
			}
		}
		// Sulkan and other Iris forks: no stable active-state API to query, so a
		// loaded shader mod conservatively disables the custom pipelines. Vanilla
		// pipelines always render correctly, with or without shaders.
		return FabricLoader.getInstance().isModLoaded("sulkan");
	}

	/** Iris pack state via {@code IrisApi}, or null when the API is unreachable. */
	private static Boolean irisPackInUse() {
		if (!irisProbed) {
			synchronized (ShaderCompat.class) {
				if (!irisProbed) {
					irisUsable = checkIrisShape();
					irisProbed = true;
					if (!irisUsable) {
						AgentCraft.LOGGER.warn("ShaderCompat: Iris API unreachable, assuming no shaders");
					}
				}
			}
		}
		if (!irisUsable) {
			return null;
		}
		try {
			Class<?> api = Class.forName("net.irisshaders.iris.api.v0.IrisApi");
			Object instance = api.getMethod("getInstance").invoke(null);
			Object result = instance.getClass().getMethod("isShaderPackInUse").invoke(instance);
			return result instanceof Boolean b ? b : null;
		} catch (ReflectiveOperationException | LinkageError e) {
			if (!irisWarned) {
				irisWarned = true;
				AgentCraft.LOGGER.warn("ShaderCompat: Iris query failed ({}), assuming no shaders", e.toString());
			}
			return null;
		}
	}

	/** The API singleton resolves fresh (it can be re-created across reloads). */
	private static boolean checkIrisShape() {
		try {
			Class<?> api = Class.forName("net.irisshaders.iris.api.v0.IrisApi");
			Object instance = api.getMethod("getInstance").invoke(null);
			instance.getClass().getMethod("isShaderPackInUse");
			return true;
		} catch (ReflectiveOperationException | LinkageError e) {
			return false;
		}
	}
}
