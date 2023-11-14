use std::str::FromStr;

pub use switchboard_solana::get_ixn_discriminator;
pub use switchboard_solana::prelude::*;
use switchboard_solana::switchboard_function;
use switchboard_solana::sb_error;

mod params;
pub use params::*;

#[switchboard_function]
pub async fn sb_function(runner: FunctionRunner, params: Vec<u8>) -> Result<Vec<Instruction>, SbFunctionError> {
    // parse and validate user provided request params
    let params: ContainerParams = ContainerParams::decode(&params).map_err(|_| SbError::ArgParseFail)?;
    // Generate our random result
    let random_result = generate_randomness(params.min_result, params.max_result);
    let mut random_bytes = random_result.to_le_bytes().to_vec();

    // IXN DATA:
    // LEN: 12 bytes
    // [0-8]: Anchor Ixn Discriminator
    // [9-12]: Random Result as u32
    let mut ixn_data = get_ixn_discriminator("settle").to_vec();
    ixn_data.append(&mut random_bytes);

    // ACCOUNTS:
    // 1. User (mut): our user who guessed
    // 2. Switchboard Function
    // 3. Switchboard Function Request
    // 4. Enclave Signer (signer): our Gramine generated keypair
    Ok(vec![Instruction {
        program_id: params.program_id,
        data: ixn_data,
        accounts: vec![
            AccountMeta::new(params.user_key, false),
            AccountMeta::new_readonly(runner.function, false),
            AccountMeta::new_readonly(runner.function_request_key.unwrap(), false),
            AccountMeta::new_readonly(runner.signer, true),
        ],
    }])
}

#[sb_error]
pub enum SbError {
    ArgParseFail,
}

fn generate_randomness(min: u32, max: u32) -> u32 {
    if min == max {
        return min;
    }
    if min > max {
        return generate_randomness(max, min);
    }

    // We add one so its inclusive [min, max]
    let window = (max + 1) - min;

    let mut bytes: [u8; 4] = [0u8; 4];
    Gramine::read_rand(&mut bytes).expect("gramine failed to generate randomness");
    let raw_result: &[u32] = bytemuck::cast_slice(&bytes[..]);

    (raw_result[0] % window) + min
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1. Check when lower_bound is greater than upper_bound
    #[test]
    fn test_generate_randomness_with_flipped_bounds() {
        let min = 100;
        let max = 50;

        let result = generate_randomness(100, 50);
        assert!(result >= max && result < min);
    }

    // 2. Check when lower_bound is equal to upper_bound
    #[test]
    fn test_generate_randomness_with_equal_bounds() {
        let bound = 100;
        assert_eq!(generate_randomness(bound, bound), bound);
    }

    // 3. Test within a range
    #[test]
    fn test_generate_randomness_within_bounds() {
        let min = 100;
        let max = 200;

        let result = generate_randomness(min, max);

        assert!(result >= min && result < max);
    }

    // 4. Test randomness distribution (not truly deterministic, but a sanity check)
    #[test]
    fn test_generate_randomness_distribution() {
        let min = 0;
        let max = 9;

        let mut counts = vec![0; 10];
        for _ in 0..1000 {
            let result = generate_randomness(min, max);
            let index: usize = result as usize;
            counts[index] += 1;
        }

        // Ensure all counts are non-zero (probabilistically should be the case)
        for count in counts.iter() {
            assert!(*count > 0);
        }
    }
}
