use anchor_lang::prelude::*;

declare_id!("CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh");

pub const ROOM_SEED: &[u8] = b"room";
pub const PRESENCE_SEED: &[u8] = b"presence";

/// Capacity of the shared room state blob. Fixed at allocation time so the
/// account never needs realloc inside the ER.
pub const MAX_ROOM_STATE: usize = 512;
/// Capacity of each player's presence blob (e.g. a cursor is 8 bytes).
pub const MAX_PRESENCE_DATA: usize = 64;

#[program]
pub mod solsocket_engine {
    use super::*;

    /// Create a room. The room PDA is keyed by (creator, room_id) so ids only
    /// need to be unique per creator, never globally.
    pub fn create_room(
        ctx: Context<CreateRoom>,
        room_id: u64,
        max_players: u16,
        initial_state: Vec<u8>,
    ) -> Result<()> {
        require!(initial_state.len() <= MAX_ROOM_STATE, SolsocketError::StateTooLarge);
        let room = &mut ctx.accounts.room;
        room.creator = ctx.accounts.creator.key();
        room.room_id = room_id;
        room.max_players = max_players;
        room.seq = 0;
        room.bump = ctx.bumps.room;
        room.state = initial_state;
        Ok(())
    }

    /// Join a room: creates (or re-initializes) the caller's presence slot and
    /// registers `authority` — the ephemeral session key that will sign this
    /// player's realtime writes on the ER. Re-joining rotates the authority.
    ///
    /// The room is passed unchecked on purpose: it may already be delegated to
    /// an ER (owner = delegation program), which would fail Anchor's owner
    /// check. Join only needs its address for the presence seeds.
    pub fn join_room(ctx: Context<JoinRoom>, authority: Pubkey) -> Result<()> {
        let presence = &mut ctx.accounts.presence;
        presence.room = ctx.accounts.room.key();
        presence.player = ctx.accounts.player.key();
        presence.authority = authority;
        presence.seq = 0;
        presence.bump = ctx.bumps.presence;
        presence.data = Vec::new();
        Ok(())
    }

    /// Write the shared room state. Any joined player may write; membership is
    /// proven by their presence slot, writes are signed by the session key.
    pub fn set_state(ctx: Context<SetState>, data: Vec<u8>) -> Result<()> {
        require!(data.len() <= MAX_ROOM_STATE, SolsocketError::StateTooLarge);
        let room = &mut ctx.accounts.room;
        room.seq += 1;
        room.state = data;
        Ok(())
    }

    /// Write the caller's own presence blob (cursor position, status, …).
    /// Per-player slots mean concurrent players never contend on one account.
    pub fn set_presence(ctx: Context<SetPresence>, data: Vec<u8>) -> Result<()> {
        require!(data.len() <= MAX_PRESENCE_DATA, SolsocketError::StateTooLarge);
        let presence = &mut ctx.accounts.presence;
        presence.seq += 1;
        presence.data = data;
        Ok(())
    }

    /// Reclaim a presence slot's rent. Base layer only, after undelegation;
    /// only the wallet that joined may close it.
    pub fn close_presence(_ctx: Context<ClosePresence>) -> Result<()> {
        Ok(())
    }

    /// Reclaim the room's rent. Base layer only, after undelegation; creator only.
    pub fn close_room(_ctx: Context<CloseRoom>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct CreateRoom<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Room::INIT_SPACE,
        seeds = [ROOM_SEED, creator.key().as_ref(), &room_id.to_le_bytes()],
        bump
    )]
    pub room: Account<'info, Room>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinRoom<'info> {
    /// CHECK: address-only reference; may be delegated (owner != this program).
    pub room: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + Presence::INIT_SPACE,
        seeds = [PRESENCE_SEED, room.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub presence: Account<'info, Presence>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetState<'info> {
    #[account(mut)]
    pub room: Account<'info, Room>,
    #[account(
        constraint = presence.room == room.key() @ SolsocketError::NotAMember,
        constraint = presence.authority == signer.key() @ SolsocketError::BadAuthority
    )]
    pub presence: Account<'info, Presence>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetPresence<'info> {
    #[account(
        mut,
        constraint = presence.authority == signer.key() @ SolsocketError::BadAuthority
    )]
    pub presence: Account<'info, Presence>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClosePresence<'info> {
    #[account(
        mut,
        close = player,
        constraint = presence.player == player.key() @ SolsocketError::BadAuthority
    )]
    pub presence: Account<'info, Presence>,
    #[account(mut)]
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseRoom<'info> {
    #[account(
        mut,
        close = creator,
        constraint = room.creator == creator.key() @ SolsocketError::BadAuthority
    )]
    pub room: Account<'info, Room>,
    #[account(mut)]
    pub creator: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Room {
    pub creator: Pubkey,
    pub room_id: u64,
    pub max_players: u16,
    pub seq: u64,
    pub bump: u8,
    #[max_len(MAX_ROOM_STATE)]
    pub state: Vec<u8>,
}

#[account]
#[derive(InitSpace)]
pub struct Presence {
    pub room: Pubkey,
    pub player: Pubkey,
    pub authority: Pubkey,
    pub seq: u64,
    pub bump: u8,
    #[max_len(MAX_PRESENCE_DATA)]
    pub data: Vec<u8>,
}

#[error_code]
pub enum SolsocketError {
    #[msg("payload exceeds the account's fixed capacity")]
    StateTooLarge,
    #[msg("presence slot does not belong to this room")]
    NotAMember,
    #[msg("signer is not the registered session authority")]
    BadAuthority,
}
