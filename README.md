# Solana Simple Randomness

This repo shows two differnt methods to use Switchboard Functions to request and
consume randomness in your Solana programs.

For each example, we start by defining our Switchboard Function account - this
account defines the code we will execute off-chain to fulfill our randomness
request. Our off-chain code will call our contract and return a random value
bounded by a `MIN_VALUE` and `MAX_VALUE`.

## Publish Switchboard Function

We'll be working backwards a bit. Switchboard Functions allow you to
**_"callback"_** into your program with some arbitrary instruction.

Start by copying the env file to set your environment. To start you can use the
default container for your program. When you're ready, you can make changes to
the Switchboard Function and deploy to your own dockerhub organization.

```bash
echo 'DOCKERHUB_IMAGE_NAME=gallynaut/solana-simple-randomness-function' > .env
```

      

## Super Simple Randomness

The first example in
[programs/super-simple-randomness](./programs/super-simple-randomness/src/lib.rs)
shows a program with two instructions:

- **request_randomness**: This function accepts a Switchboard Function
