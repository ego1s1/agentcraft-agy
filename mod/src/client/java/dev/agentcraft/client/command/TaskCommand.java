package dev.agentcraft.client.command;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanLink;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * Chat fallbacks for the Task Wall buttons, for when clicks cannot be used
 * (e.g. the client lost sync with the Foreman during a network outage).
 * Usage:
 *   /task &lt;id&gt; retry|prioritize|cancel
 *   /task &lt;id&gt; reassign &lt;agent&gt;
 *   /agentcraft reconnect   - drop the Foreman link and reconnect right now
 */
public final class TaskCommand {
	private TaskCommand() {
	}

	public static void init() {
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> {
			dispatcher.register(ClientCommands.literal("task")
				.then(ClientCommands.argument("taskId", StringArgumentType.word())
					.then(ClientCommands.literal("retry").executes(ctx -> doAction(ctx, "retry", null)))
					.then(ClientCommands.literal("prioritize").executes(ctx -> doAction(ctx, "prioritize", null)))
					.then(ClientCommands.literal("cancel").executes(ctx -> doAction(ctx, "cancel", null)))
					.then(ClientCommands.literal("reassign")
						.then(ClientCommands.argument("agent", StringArgumentType.word())
							.executes(ctx -> doAction(ctx, "reassign", StringArgumentType.getString(ctx, "agent")))))));

			dispatcher.register(ClientCommands.literal("agentcraft")
				.then(ClientCommands.literal("reconnect").executes(TaskCommand::doReconnect)));
		});
	}

	private static int doAction(CommandContext<FabricClientCommandSource> ctx, String action, @Nullable String arg) {
		FabricClientCommandSource source = ctx.getSource();
		String taskId = StringArgumentType.getString(ctx, "taskId");
		if (Foreman.link() == null) {
			source.sendError(Component.literal("§c[AgentCraft] Foreman link not available"));
			return 0;
		}
		source.sendFeedback(Component.literal("§6[AgentCraft] §fSending " + action + " for §e" + taskId + "..."));
		Foreman.taskAction(taskId, action, arg).whenComplete((ack, err) -> {
			if (err != null) {
				source.sendError(Component.literal("§c[AgentCraft] Not sent: " + (err.getMessage() == null ? err.toString() : err.getMessage())));
			} else if (ack != null && !ack.ok()) {
				source.sendError(Component.literal("§c[AgentCraft] Foreman refused: " + (ack.error() != null ? ack.error() : "unknown error")));
			} else {
				source.sendFeedback(Component.literal("§a[AgentCraft] " + taskId + " " + pastTense(action, arg)));
			}
		});
		return 1;
	}

	private static String pastTense(String action, @Nullable String arg) {
		return switch (action) {
			case "retry" -> "queued again";
			case "prioritize" -> "moved to the top of the queue";
			case "cancel" -> "cancelled";
			default -> "reassigned to " + (arg == null ? "?" : arg);
		};
	}

	private static int doReconnect(CommandContext<FabricClientCommandSource> ctx) {
		FabricClientCommandSource source = ctx.getSource();
		ForemanLink link = Foreman.link();
		if (link == null) {
			source.sendError(Component.literal("§c[AgentCraft] Foreman link not available"));
			return 0;
		}
		link.reconnectNow();
		source.sendFeedback(Component.literal("§6[AgentCraft] §fReconnect requested — watch the top banner for §eForeman · <backend>"));
		return 1;
	}
}
