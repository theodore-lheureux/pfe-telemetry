FROM semaphoreui/semaphore:v2.20.23@sha256:00e6733dbca9a2bddf77e048f34f9002027c8a6f549a8cde18d13101e84a19c3 AS semaphore
FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:593.0.0-stable@sha256:54e711173abf8aebf025d0a20815088bfb6ab627eae39d8d0ab6df6ec114cbf6
ARG TARGETARCH
RUN test "$TARGETARCH" = arm64
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv openssh-client ca-certificates git tini curl jq unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=semaphore /usr/local/bin/semaphore /usr/local/bin/semaphore
RUN curl --fail --location --output /tmp/tofu.zip \
      https://github.com/opentofu/opentofu/releases/download/v1.13.9/tofu_1.13.9_linux_arm64.zip \
    && echo '04f7c93828b859d420269ed30f923ffebf09157b5d7fb95bf8d88a4d208b7fa3  /tmp/tofu.zip' | sha256sum --check \
    && unzip /tmp/tofu.zip tofu -d /usr/local/bin \
    && rm /tmp/tofu.zip
COPY infra/semaphore/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/ansible \
    && /opt/ansible/bin/pip install --no-cache-dir --only-binary=:all: --require-hashes -r /tmp/requirements.txt \
    && useradd --uid 1001 --create-home runner \
    && mkdir -p /var/lib/recount-demo /var/lib/semaphore-runner /opt/tofu-providers \
    && chown 1001:1001 /var/lib/recount-demo /var/lib/semaphore-runner
COPY infra/demo /opt/recount/infra/demo
COPY infra/semaphore /opt/recount/infra/semaphore
RUN curl --fail --location --output /tmp/session-manager-plugin.deb \
      https://s3.amazonaws.com/session-manager-downloads/plugin/1.2.896.0/ubuntu_arm64/session-manager-plugin.deb \
    && echo '914eeca87b18b55356c58be197080f73742b3ca60d3823f0a45670dc9056aa9c  /tmp/session-manager-plugin.deb' | sha256sum --check \
    && dpkg --install /tmp/session-manager-plugin.deb \
    && rm /tmp/session-manager-plugin.deb \
    && curl --fail --location --output /tmp/gh.tar.gz \
      https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_linux_arm64.tar.gz \
    && echo 'cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3  /tmp/gh.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/gh.tar.gz -C /tmp gh_2.104.0_linux_arm64/bin/gh \
    && install /tmp/gh_2.104.0_linux_arm64/bin/gh /usr/local/bin/gh \
    && rm /tmp/gh.tar.gz \
    && TF_PLUGIN_CACHE_DIR=/opt/tofu-providers tofu -chdir=/opt/recount/infra/demo/tofu/gcp-gpu init -backend=false -input=false -lockfile=readonly \
    && TF_PLUGIN_CACHE_DIR=/opt/tofu-providers tofu -chdir=/opt/recount/infra/demo/tofu/aws-cpu init -backend=false -input=false -lockfile=readonly
ENV PATH="/opt/ansible/bin:/usr/lib/google-cloud-sdk/bin:/usr/local/bin:/usr/bin:/bin" \
    HOME="/tmp/runner-home" \
    SEMAPHORE_HOME_DIR_MODE="user_home" \
    ANSIBLE_CONFIG="/opt/recount/infra/semaphore/ansible.cfg"
USER 1001:1001
WORKDIR /opt/recount
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/sh", "/opt/recount/infra/semaphore/runner.sh"]
