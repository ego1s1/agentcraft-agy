package dev.agentcraft.client.command;

import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanJson;
import dev.agentcraft.client.foreman.ForemanLink;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.ForemanStatus;
import java.util.Locale;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.network.chat.Component;

/**
 * Chat command to query and change reasoning effort (low, med, high, max) or model.
 * Usage:
 *   /model                  - shows active model & reasoning effort
 *   /model low              - sets effort to low
 *   /model med (or medium)  - sets effort to medium
 *   /model high             - sets effort to high
 *   /model max              - sets effort to max
 *   /model <model_name>     - sets model name (e.g. gemini-2.5-pro, claude-3-7-sonnet)
 */
public final class ModelCommand {
	private ModelCommand() {
	}

	public static void init() {
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> {
			// Register /model
			dispatcher.register(ClientCommands.literal("model")
				.executes(ModelCommand::showStatus)
				.then(ClientCommands.argument("value", StringArgumentType.word())
					.suggests((ctx, builder) -> {
						builder.suggest("low");
						builder.suggest("med");
						builder.suggest("medium");
						builder.suggest("high");
						builder.suggest("max");
						builder.suggest("gemini-2.5-pro");
						builder.suggest("gemini-2.5-flash");
						return builder.buildFuture();
					})
					.executes(ModelCommand::applyValue)));

			// Also register /agentcraft model
			dispatcher.register(ClientCommands.literal("agentcraft")
				.then(ClientCommands.literal("model")
					.executes(ModelCommand::showStatus)
					.then(ClientCommands.argument("value", StringArgumentType.word())
						.suggests((ctx, builder) -> {
							builder.suggest("low");
							builder.suggest("med");
							builder.suggest("medium");
							builder.suggest("high");
							builder.suggest("max");
							return builder.buildFuture();
						})
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

		source.sendFeedback(Component.literal("§6[AgentCraft] §fBackend: §e" + backend + " §7| §fEffort: §b" + effort + " §7| §fModel: §a" + model));
		source.sendFeedback(Component.literal("§7Change effort: §f/model §b<low|med|high|max>§7 or set model: §f/model §a<name>"));
		return 1;
	}

	private static int applyValue(CommandContext<FabricClientCommandSource> ctx) {
		FabricClientCommandSource source = ctx.getSource();
		String raw = StringArgumentType.getString(ctx, "value").trim();
		String lower = raw.toLowerCase(Locale.ROOT);

		ForemanLink link = Foreman.link();
		if (link == null) {
			source.sendError(Component.literal("§c[AgentCraft] Foreman link not available"));
			return 0;
		}

		String effort = null;
		String model = null;

		switch (lower) {
			case "low" -> effort = "low";
			case "med", "medium" -> effort = "medium";
			case "high" -> effort = "high";
			case "max", "xhigh" -> effort = "max";
			default -> model = raw;
		}

		JsonObject msg = ForemanJson.msg("config.set").json();
		if (effort != null) {
			msg.addProperty("effort", effort);
		}
		if (model != null) {
			msg.addProperty("model", model);
		}

		final String appliedEffort = effort;
		final String appliedModel = model;

		link.send(msg).whenComplete((ack, err) -> {
			if (err != null) {
				source.sendError(Component.literal("§c[AgentCraft] Failed to update config: " + err.getMessage()));
			} else if (ack != null && !ack.ok()) {
				source.sendError(Component.literal("§c[AgentCraft] Foreman refused: " + (ack.error() != null ? ack.error() : "unknown error")));
			} else {
				if (appliedEffort != null) {
					source.sendFeedback(Component.literal("§a[AgentCraft] Reasoning effort set to §b" + appliedEffort));
				}
				if (appliedModel != null) {
					source.sendFeedback(Component.literal("§a[AgentCraft] Model set to §a" + appliedModel));
				}
			}
		});

		return 1;
	}
}
