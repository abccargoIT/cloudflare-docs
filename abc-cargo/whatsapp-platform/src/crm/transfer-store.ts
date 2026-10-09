/**
 * Where a transfer is read from and written to.
 *
 * The decision — who may, what it warns about, that the channel never moves —
 * is `transfer.ts` and is pure. This file loads the conversation as that
 * module needs to see it, and writes the result atomically.
 *
 * Two things here are worth knowing before changing them.
 *
 * **The destination region comes from the team, not from the request.** A
 * caller sends the team they want; the region is read from the `teams` table.
 * Trusting a region in the request body would let a caller move a
 * conversation into a region the named team does not belong to, which is
 * exactly the kind of mismatch the regional scoping exists to prevent.
 *
 * **The first-response clock is the ticket's.** The live platform keeps its
 * service targets on tickets, not on conversations, so the "already late" and
 * "falls outside the receiving desk's hours" warnings use the conversation's
 * open ticket. A conversation with no ticket has no target to be late against,
 * and the transfer says nothing about one rather than inventing it.
 */

import type {
	TransferRecord,
	TransferWarning,
	TransferableConversation,
} from "./transfer.ts";

export interface TeamRow {
	id: string;
	name: string;
	region_id: string;
}

export interface TransferRow {
	id: string;
	conversation_id: string;
	from_region_id: string;
	to_region_id: string;
	from_team_id: string | null;
	to_team_id: string;
	from_agent_id: string | null;
	to_agent_id: string | null;
	actor: string;
	reason: string;
	cross_region: number;
	warnings: string;
	occurred_at: string;
}

export class TransferStore {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/** The conversation as `transferConversation` needs it, or null. */
	async loadTransferable(
		conversationId: string,
	): Promise<TransferableConversation | null> {
		const convo = await this.db
			.prepare(
				`SELECT id, region_id, phone_number_id, assigned_agent_id,
				        assigned_team_id, window_expires_at
				   FROM conversations WHERE id = ?1`,
			)
			.bind(conversationId)
			.first<{
				id: string;
				region_id: string;
				phone_number_id: string;
				assigned_agent_id: string | null;
				assigned_team_id: string | null;
				window_expires_at: string | null;
			}>();
		if (!convo) return null;

		// The open ticket's first-response clock, if there is one.
		const ticket = await this.db
			.prepare(
				`SELECT first_response_due_at, first_response_at
				   FROM tickets
				  WHERE conversation_id = ?1 AND status IN ('open', 'pending')
				  ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(conversationId)
			.first<{
				first_response_due_at: string;
				first_response_at: string | null;
			}>();

		return {
			id: convo.id,
			regionId: convo.region_id,
			phoneNumberId: convo.phone_number_id,
			assignedAgentId: convo.assigned_agent_id,
			assignedTeamId: convo.assigned_team_id,
			windowExpiresAt: convo.window_expires_at,
			firstResponseDueAt: ticket?.first_response_due_at ?? null,
			firstRespondedAt: ticket?.first_response_at ?? null,
		};
	}

	async team(teamId: string): Promise<TeamRow | null> {
		return this.db
			.prepare(`SELECT id, name, region_id FROM teams WHERE id = ?1`)
			.bind(teamId)
			.first<TeamRow>();
	}

	/**
	 * Whether a named recipient is an active member of the receiving team.
	 *
	 * Checked before a transfer names someone, because handing a case to a
	 * person outside the team puts it where that team's lead cannot see it,
	 * and handing it to a suspended account puts it where nobody can.
	 */
	async isActiveMember(userId: string, teamId: string): Promise<boolean> {
		const row = await this.db
			.prepare(
				`SELECT 1 AS x FROM user_teams ut
				   JOIN users u ON u.id = ut.user_id
				  WHERE ut.user_id = ?1 AND ut.team_id = ?2 AND u.status = 'active'`,
			)
			.bind(userId, teamId)
			.first<{ x: number }>();
		return !!row;
	}

	async teams(): Promise<TeamRow[]> {
		const rows = await this.db
			.prepare(`SELECT id, name, region_id FROM teams ORDER BY region_id, name`)
			.all<TeamRow>();
		return rows.results ?? [];
	}

	/**
	 * Moves ownership and records the transfer, in one batch.
	 *
	 * One batch because the two must not come apart: a transfer row with no
	 * change of ownership claims something that did not happen, and a change of
	 * ownership with no row is a conversation that moved country for no reason
	 * anyone wrote down.
	 *
	 * `phone_number_id` is not in the UPDATE. That is the point of the module.
	 */
	async apply(
		record: TransferRecord,
		warnings: TransferWarning[],
		id: string = `xfer_${crypto.randomUUID()}`,
	): Promise<string> {
		await this.db.batch([
			this.db
				.prepare(
					`UPDATE conversations
					    SET region_id = ?2,
					        assigned_team_id = ?3,
					        assigned_agent_id = ?4,
					        updated_at = ?5
					  WHERE id = ?1`,
				)
				.bind(
					record.conversationId,
					record.toRegionId,
					record.toTeamId,
					record.toAgentId,
					record.at,
				),
			this.db
				.prepare(
					`INSERT INTO conversation_transfers
					   (id, conversation_id, from_region_id, to_region_id,
					    from_team_id, to_team_id, from_agent_id, to_agent_id,
					    actor, reason, cross_region, warnings, occurred_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
				)
				.bind(
					id,
					record.conversationId,
					record.fromRegionId,
					record.toRegionId,
					record.fromTeamId,
					record.toTeamId,
					record.fromAgentId,
					record.toAgentId,
					record.actor,
					record.reason,
					record.crossRegion ? 1 : 0,
					JSON.stringify(warnings.map((w) => w.code)),
					record.at,
				),
		]);
		return id;
	}

	async history(conversationId: string, limit = 20): Promise<TransferRow[]> {
		const rows = await this.db
			.prepare(
				`SELECT * FROM conversation_transfers
				  WHERE conversation_id = ?1
				  ORDER BY occurred_at DESC LIMIT ?2`,
			)
			.bind(conversationId, limit)
			.all<TransferRow>();
		return rows.results ?? [];
	}
}
