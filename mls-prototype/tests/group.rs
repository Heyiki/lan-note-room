use lan_chat_mls_prototype::Client;
use openmls::prelude::{MlsMessageBodyIn, MlsMessageIn};
use tls_codec::Deserialize;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn pair() -> Result<(Client, Client), Box<dyn std::error::Error>> {
    let mut alice = Client::new("alice")?;
    alice.create_group("test-room")?;
    let mut bob = Client::new("bob")?;
    let admission = alice.add_member(&bob.key_package()?)?;
    bob.join(&admission.welcome)?;
    Ok((alice, bob))
}

#[test]
fn messages_are_encrypted_and_the_sender_is_authenticated() -> TestResult {
    let (mut alice, mut bob) = pair()?;
    let ciphertext = alice.encrypt(b"first secret")?;
    assert!(!ciphertext.windows(12).any(|part| part == b"first secret"));
    let message = bob.process(&ciphertext)?.expect("application message");
    assert_eq!(message.sender, "alice");
    assert_eq!(message.bytes, b"first secret");
    let reply = bob.encrypt(b"reply")?;
    let received = alice.process(&reply)?.expect("reply");
    assert_eq!(received.sender, "bob");
    assert_eq!(received.bytes, b"reply");
    Ok(())
}

#[test]
fn a_new_member_cannot_decrypt_messages_from_before_admission() -> TestResult {
    let (mut alice, mut bob) = pair()?;
    let old_message = alice.encrypt(b"before carol joined")?;
    let mut carol = Client::new("carol")?;
    let admission = alice.add_member(&carol.key_package()?)?;
    assert!(bob.process(&admission.commit)?.is_none());
    carol.join(&admission.welcome)?;
    assert!(carol.process(&old_message).is_err());
    let current_message = bob.encrypt(b"three members")?;
    assert_eq!(
        carol
            .process(&current_message)?
            .expect("current message")
            .bytes,
        b"three members"
    );
    assert_eq!(
        alice
            .process(&current_message)?
            .expect("current message")
            .bytes,
        b"three members"
    );
    Ok(())
}

#[test]
fn a_removed_member_with_old_keys_cannot_decrypt_future_messages() -> TestResult {
    let (mut alice, mut bob) = pair()?;
    let mut carol = Client::new("carol")?;
    let admission = alice.add_member(&carol.key_package()?)?;
    bob.process(&admission.commit)?;
    carol.join(&admission.welcome)?;
    let removal = alice.remove_member("bob")?;
    carol.process(&removal)?;
    let ciphertext = alice.encrypt(b"after bob left")?;
    assert!(bob.process(&ciphertext).is_err());
    assert_eq!(
        carol.process(&ciphertext)?.expect("remaining member").bytes,
        b"after bob left"
    );
    bob.process(&removal)?;
    assert!(bob.encrypt(b"removed sender").is_err());
    Ok(())
}

#[test]
fn corrupted_ciphertext_is_rejected_without_accepting_plaintext() -> TestResult {
    let (mut alice, mut bob) = pair()?;
    let mut ciphertext = alice.encrypt(b"integrity")?;
    *ciphertext.last_mut().expect("nonempty ciphertext") ^= 0x80;
    assert!(bob.process(&ciphertext).is_err());
    assert!(bob.process(b"plaintext is not an MLS message").is_err());
    Ok(())
}

#[test]
fn restored_state_can_receive_and_send_without_reusing_old_sender_state() -> TestResult {
    let (mut alice, mut bob) = pair()?;
    let initial = bob.encrypt(b"before refresh")?;
    alice.process(&initial)?;
    let snapshot = bob.snapshot()?;
    drop(bob);
    let mut restored = Client::restore(&snapshot)?;
    let next = alice.encrypt(b"after refresh")?;
    let received = restored.process(&next)?.expect("restored receiver");
    assert_eq!(received.sender, "alice");
    assert_eq!(received.bytes, b"after refresh");
    let reply = restored.encrypt(b"restored sender")?;
    assert_eq!(
        alice.process(&reply)?.expect("restored send").bytes,
        b"restored sender"
    );
    assert!(restored.process(&next).is_err(), "replay must be rejected");
    Ok(())
}

#[test]
fn group_description_binds_room_and_member_signing_keys() -> TestResult {
    let (alice, bob) = pair()?;
    let description = alice.describe()?;
    assert_eq!(description.group_id.as_deref(), Some("test-room"));
    assert_eq!(description.identity, "alice");
    assert_eq!(description.members.len(), 2);
    assert!(description
        .members
        .iter()
        .any(|member| member.identity == "bob"));
    assert_eq!(description.members, bob.describe()?.members);
    assert_eq!(description.fingerprint.len(), 64);
    Ok(())
}

#[test]
fn membership_commits_are_signed_public_messages_not_sender_ratchet_ciphertexts() -> TestResult {
    let mut alice = Client::new("alice")?;
    alice.create_group("public-handshakes")?;
    let bob = Client::new("bob")?;
    let admission = alice.add_member(&bob.key_package()?)?;
    assert!(matches!(
        MlsMessageIn::tls_deserialize_exact(admission.commit)?.extract(),
        MlsMessageBodyIn::PublicMessage(_)
    ));
    Ok(())
}

#[test]
fn forged_relay_sender_attribution_is_rejected() -> TestResult {
    let (mut alice, mut bob) = pair()?;
    let ciphertext = alice.encrypt(b"actual author is alice")?;
    assert!(bob.process_from(&ciphertext, Some("mallory")).is_err());
    Ok(())
}

#[test]
fn rejected_public_admission_can_restore_and_accept_a_competing_commit() -> TestResult {
    let (mut alice, mut bob) = pair()?;
    let mut carol = Client::new("carol")?;
    let package = carol.key_package()?;
    let before = alice.snapshot()?;
    let _rejected = alice.add_member(&package)?;
    let accepted = bob.add_member(&package)?;
    drop(alice);
    let mut alice = Client::restore(&before)?;
    alice.process_from(&accepted.commit, Some("bob"))?;
    carol.join(&accepted.welcome)?;
    let ciphertext = alice.encrypt(b"after competing commit")?;
    assert_eq!(
        carol.process(&ciphertext)?.expect("new member").bytes,
        b"after competing commit"
    );
    Ok(())
}
