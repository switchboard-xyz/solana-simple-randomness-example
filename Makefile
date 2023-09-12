# include .env file and export its env vars
# (-include to ignore error if it does not exist)
-include .env

.PHONY: build clean publish test

# Variables
DOCKER_IMAGE_NAME ?= gallynaut/solana-simple-randomness-function

check_docker_env:
ifeq ($(strip $(DOCKERHUB_IMAGE_NAME)),)
	$(error DOCKERHUB_IMAGE_NAME is not set)
else
	@echo DOCKERHUB_IMAGE_NAME: ${DOCKERHUB_IMAGE_NAME}
endif

# Default make task
all: build

anchor_build :; anchor build
anchor_publish:; anchor deploy --provider.cluster devnet

docker_build: 
	DOCKER_BUILDKIT=1 docker buildx build --platform linux/amd64 --pull -f Dockerfile -t ${DOCKER_IMAGE_NAME}:dev --load ./
docker_publish: 
	DOCKER_BUILDKIT=1 docker buildx build --no-cache --platform linux/amd64 --pull -f Dockerfile -t ${DOCKER_IMAGE_NAME} --push ./

build: anchor_build docker_build measurement

dev: dev_docker_build measurement

publish: anchor_publish docker_publish measurement

measurement-rust-function: check_docker_env
	docker pull --platform=linux/amd64 -q ${DOCKERHUB_IMAGE_NAME}:latest
	@docker run -d --platform=linux/amd64 -q --name=my-switchboard-function ${DOCKERHUB_IMAGE_NAME}:latest
	@docker cp my-switchboard-function:/measurement.txt ./measurement.txt
	@echo -n 'MrEnclve: '
	@cat measurement.txt
	@docker stop my-switchboard-function > /dev/null
	@docker rm my-switchboard-function > /dev/null

# Task to clean up the compiled rust application
clean:
	cargo clean
