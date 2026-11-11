use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize, Serialize};
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

pub struct Client {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    group: Option<MlsGroup>,
}

#[derive(Serialize)]
pub struct Admission {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

#[derive(Serialize)]
pub struct Application {
    pub sender: String,
    pub bytes: Vec<u8>,
}

#[derive(Serialize, PartialEq, Debug)]
pub struct MemberDescription {
    pub identity: String,
    pub fingerprint: String,
}

#[derive(Serialize)]
pub struct Description {
    pub identity: String,
    pub fingerprint: String,
    pub group_id: Option<String>,
    pub members: Vec<MemberDescription>,
}

fn fingerprint(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    group_id: Option<Vec<u8>>,
    storage: Vec<(Vec<u8>, Vec<u8>)>,
}

impl Client {
    pub fn describe(&self) -> Result<Description> {
        let identity = BasicCredential::try_from(self.credential.credential.clone())?;
        let members = match &self.group {
            Some(group) => group
                .members()
                .map(|member| {
                    let credential = BasicCredential::try_from(member.credential)?;
                    Ok(MemberDescription {
                        identity: String::from_utf8(credential.identity().to_vec())?,
                        fingerprint: fingerprint(&member.signature_key),
                    })
                })
                .collect::<Result<Vec<_>>>()?,
            None => Vec::new(),
        };
        Ok(Description {
            identity: String::from_utf8(identity.identity().to_vec())?,
            fingerprint: fingerprint(self.signer.public()),
            group_id: self
                .group
                .as_ref()
                .map(|group| String::from_utf8(group.group_id().as_slice().to_vec()))
                .transpose()?,
            members,
        })
    }
    pub fn new(identity: &str) -> Result<Self> {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SignatureScheme::ED25519)?;
        signer.store(provider.storage())?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.as_bytes().to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential,
            group: None,
        })
    }

    pub fn create_group(&mut self, group_id: &str) -> Result<()> {
        if self.group.is_some() {
            return Err("client already has a group".into());
        }
        self.group = Some(
            MlsGroup::builder()
                .ciphersuite(SUITE)
                .with_wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
                .use_ratchet_tree_extension(true)
                .with_group_id(GroupId::from_slice(group_id.as_bytes()))
                .build(&self.provider, &self.signer, self.credential.clone())?,
        );
        Ok(())
    }

    pub fn key_package(&self) -> Result<Vec<u8>> {
        Ok(KeyPackage::builder()
            .build(SUITE, &self.provider, &self.signer, self.credential.clone())?
            .key_package()
            .tls_serialize_detached()?)
    }

    pub fn add_member(&mut self, bytes: &[u8]) -> Result<Admission> {
        let package = KeyPackageIn::tls_deserialize_exact(bytes)?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)?;
        let group = self.group.as_mut().ok_or("no group")?;
        let (commit, welcome, _) = group.add_members(&self.provider, &self.signer, &[package])?;
        let result = Admission {
            commit: commit.tls_serialize_detached()?,
            welcome: MlsMessageOut::from(welcome).tls_serialize_detached()?,
        };
        group.merge_pending_commit(&self.provider)?;
        Ok(result)
    }

    pub fn join(&mut self, bytes: &[u8]) -> Result<()> {
        if self.group.is_some() {
            return Err("client already has a group".into());
        }
        let welcome = match MlsMessageIn::tls_deserialize_exact(bytes)?.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err("expected Welcome".into()),
        };
        self.group = Some(
            StagedWelcome::new_from_welcome(
                &self.provider,
                &MlsGroupJoinConfig::builder()
                    .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
                    .use_ratchet_tree_extension(true)
                    .build(),
                welcome,
                None,
            )?
            .into_group(&self.provider)?,
        );
        Ok(())
    }

    pub fn encrypt(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        Ok(self
            .group
            .as_mut()
            .ok_or("no group")?
            .create_message(&self.provider, &self.signer, bytes)?
            .tls_serialize_detached()?)
    }

    pub fn process(&mut self, bytes: &[u8]) -> Result<Option<Application>> {
        self.process_from(bytes, None)
    }

    pub fn process_from(
        &mut self,
        bytes: &[u8],
        expected_sender: Option<&str>,
    ) -> Result<Option<Application>> {
        let message = MlsMessageIn::tls_deserialize_exact(bytes)?.try_into_protocol_message()?;
        let group = self.group.as_mut().ok_or("no group")?;
        let processed = group.process_message(&self.provider, message)?;
        let identity = BasicCredential::try_from(processed.credential().clone())?;
        let sender = String::from_utf8(identity.identity().to_vec())?;
        if expected_sender.is_some_and(|expected| expected != sender) {
            return Err("authenticated sender does not match relay attribution".into());
        }
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => Ok(Some(Application {
                sender,
                bytes: message.into_bytes(),
            })),
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                group.merge_staged_commit(&self.provider, *commit)?;
                Ok(None)
            }
            _ => Err("unsupported protocol message".into()),
        }
    }

    pub fn remove_member(&mut self, identity: &str) -> Result<Vec<u8>> {
        let group = self.group.as_mut().ok_or("no group")?;
        let index = group
            .members()
            .find_map(|member| {
                let credential = BasicCredential::try_from(member.credential).ok()?;
                (credential.identity() == identity.as_bytes()).then_some(member.index)
            })
            .ok_or("member not found")?;
        let (commit, _, _) = group.remove_members(&self.provider, &self.signer, &[index])?;
        let bytes = commit.tls_serialize_detached()?;
        group.merge_pending_commit(&self.provider)?;
        Ok(bytes)
    }

    // Contains private keys. This snapshot must stay on the owning endpoint.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let storage = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| "storage lock poisoned")?
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        Ok(serde_json::to_vec(&Snapshot {
            signer: self.signer.clone(),
            credential: self.credential.clone(),
            group_id: self
                .group
                .as_ref()
                .map(|group| group.group_id().as_slice().to_vec()),
            storage,
        })?)
    }

    pub fn restore(bytes: &[u8]) -> Result<Self> {
        let snapshot: Snapshot = serde_json::from_slice(bytes)?;
        let provider = OpenMlsRustCrypto::default();
        *provider
            .storage()
            .values
            .write()
            .map_err(|_| "storage lock poisoned")? = snapshot.storage.into_iter().collect();
        let group = match snapshot.group_id {
            Some(id) => Some(
                MlsGroup::load(provider.storage(), &GroupId::from_slice(&id))?
                    .ok_or("stored group missing")?,
            ),
            None => None,
        };
        Ok(Self {
            provider,
            signer: snapshot.signer,
            credential: snapshot.credential,
            group,
        })
    }
}

#[cfg(target_arch = "wasm32")]
mod browser {
    use super::*;
    use wasm_bindgen::prelude::*;

    fn js_error(error: Box<dyn std::error::Error>) -> JsError {
        JsError::new(&error.to_string())
    }

    #[wasm_bindgen]
    pub struct BrowserClient(Client);

    #[wasm_bindgen]
    impl BrowserClient {
        pub fn describe(&self) -> std::result::Result<String, JsError> {
            let description = self.0.describe().map_err(js_error)?;
            serde_json::to_string(&description).map_err(|error| JsError::new(&error.to_string()))
        }
        #[wasm_bindgen(constructor)]
        pub fn new(identity: &str) -> std::result::Result<BrowserClient, JsError> {
            Client::new(identity).map(Self).map_err(js_error)
        }

        pub fn create_group(&mut self, id: &str) -> std::result::Result<(), JsError> {
            self.0.create_group(id).map_err(js_error)
        }

        pub fn key_package(&self) -> std::result::Result<Vec<u8>, JsError> {
            self.0.key_package().map_err(js_error)
        }

        pub fn add_member(&mut self, bytes: &[u8]) -> std::result::Result<String, JsError> {
            let admission = self.0.add_member(bytes).map_err(js_error)?;
            serde_json::to_string(&admission).map_err(|error| JsError::new(&error.to_string()))
        }

        pub fn join(&mut self, welcome: &[u8]) -> std::result::Result<(), JsError> {
            self.0.join(welcome).map_err(js_error)
        }

        pub fn encrypt(&mut self, bytes: &[u8]) -> std::result::Result<Vec<u8>, JsError> {
            self.0.encrypt(bytes).map_err(js_error)
        }

        pub fn process(&mut self, bytes: &[u8]) -> std::result::Result<String, JsError> {
            let message = self.0.process(bytes).map_err(js_error)?;
            serde_json::to_string(&message).map_err(|error| JsError::new(&error.to_string()))
        }

        pub fn process_from(
            &mut self,
            bytes: &[u8],
            sender: &str,
        ) -> std::result::Result<String, JsError> {
            let message = self.0.process_from(bytes, Some(sender)).map_err(js_error)?;
            serde_json::to_string(&message).map_err(|error| JsError::new(&error.to_string()))
        }

        pub fn remove_member(&mut self, identity: &str) -> std::result::Result<Vec<u8>, JsError> {
            self.0.remove_member(identity).map_err(js_error)
        }

        pub fn snapshot(&self) -> std::result::Result<Vec<u8>, JsError> {
            self.0.snapshot().map_err(js_error)
        }

        pub fn restore(bytes: &[u8]) -> std::result::Result<BrowserClient, JsError> {
            Client::restore(bytes).map(Self).map_err(js_error)
        }
    }
}
