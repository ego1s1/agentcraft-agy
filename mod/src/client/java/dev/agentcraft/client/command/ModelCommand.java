package dev.agentcraft.client.command;

import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanLink;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.ForemanStatus;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.network.chat.Component;

/**
 * Chat command to query and pick reasoning effort (low, med, high, max), weight
 * presets (heavy, medium, light) or models.
 * Usage:
 *   /model                  - shows backend, preset, effort and models
 *   /model low              - sets effort to low
 *   /model med (or medium)  - sets effort to medium
 *   /model high             - sets effort to high
 *   /model max              - sets effort to max
 *   /model heavy|medium|light - applies the weight preset
 *   /model list             - numbered pickable models for the backend
 *   /model <n|name>         - picks a model from the list (or any model name)
 *   /model lead|worker <name> - model for the lead or the workers only
 *   /model details <n|name> - what a model is for
 */
public final class ModelCommand {
	private ModelCommand() {
	}

	public static void init() {
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> {
			// Register /model
			dispatcher.register(ClientCommands.literal("model")
				.executes(ModelCommand::showStatus)
				.then(ClientCommands.argument("value", StringArgumentType.greedyString())
					.suggests((ctx, builder) -> {
						for (String s : new String[]{"low", "med", "medium", "high", "max", "heavy", "medium", "light",
							"list", "lead", "worker", "details"}) {
							builder.suggest(s);
						}
						return builder.buildFuture();
					})
					.executes(ModelCommand::applyValue)));

			// Also register /agentcraft model
			dispatcher.register(ClientCommands.literal("agentcraft")
				.then(ClientCommands.literal("model")
					.executes(ModelCommand::showStatus)
					.then(ClientCommands.argument("value", StringArgumentType.greedyString())
						.executes(ModelCommand::applyValue))));
		});
	}

	private static int showStatus(CommandContext<FabricClientCommandSource> ctx) {
		FabricClientCommandSource source = ctx.getSource();
		ForemanState state = Foreman.state();
		ForemanStatus status = state != null ? state.status() : null;

		String backend = (status != null && status.backend() != null) ? status.backend().wire() : "unknown";
		String effort = (status != null && status.effort() != null) ? status.effort() : "medium";
		String model = (status != null && status.model() != null) ? status.model() : "default";
		String preset = (status != null && status.preset() != null) ? status.preset() : null;

		source.sendFeedback(Component.literal("§6[AgentCraft] §fBackend: §e" + backend +
			(preset != null ? " §7[§b" + preset + "§7]" : "") + " §7| §fEffort: §b" + effort + " §7| §fModel: §a" + model));
		source.sendFeedback(Component.literal("§7/model §bheavy|medium|light§7, §f/model list§7, §f/model §a<n|name>§7, §f/model §alead|worker§7 <name>"));
		return 1;
	}

	private static int applyValue(CommandContext<FabricClientCommandSource> ctx) {
		FabricClientCommandSource source = ctx.getSource();
		String raw = StringArgumentType.getString(ctx, "value").trim();
		if (raw.isEmpty()) {
			return showStatus(ctx);
		}

		ForemanLink link = Foreman.link();
		if (link == null) {
			source.sendError(Component.literal("§c[AgentCraft] Foreman link not available"));
			return 0;
		}

		// One shared resolver on the Foreman side (see Foreman.handleModelCommand):
		// presets, list/details, lead/worker, effort words and model names.
		Foreman.message("all", "/model " + raw).whenComplete((ack, err) -> {
			if (err != null) {
				source.sendError(Component.literal("§c[AgentCraft] Failed: " + (err.getMessage() == null ? err.toString() : err.getMessage())));
			} else if (ack != null && !ack.ok()) {
				source.sendError(Component.literal("§c[AgentCraft] Foreman refused: " + (ack.error() != null ? ack.error() : "unknown error")));
			} else if (ack != null && ack.result() != null && ack.result().has("text")) {
				String text = ack.result().get("text").getAsString();
				boolean first = true;
				for (String line : text.split("\n")) {
					source.sendFeedback(Component.literal((first ? "§6[AgentCraft] §f" : "§7> §f") + line));
					first = false;
				}
			} else {
				source.sendFeedback(Component.literal("§a[AgentCraft] Done"));
			}
		});

		return 1;
	}
}
