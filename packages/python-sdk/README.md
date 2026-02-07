# Axis Python SDK

The official Python client for the Axis Context Protocol. 

## Installation

```bash
pip install virsanghavi-axis
```

## Quick Start

### 1. Initialize the Client

```python
from axis import Axis

# Reads AXIS_API_KEY from environment by default
axis = Axis() 
```

### 2. Get a Context Mirror

```python
mirror = axis.get_mirror(path="./src")

# Convert to text for your prompt
prompt_context = mirror.to_prompt()
print(prompt_context)
```

### 3. Check Governance

```python
is_allowed = axis.check_governance(
    agent_id="agent-001",
    file_path="src/auth/secrets.ts",
    action="read"
)

if not is_allowed:
    print("Access Denied by Axis Governance Law")
```

## Environment Variables

- `AXIS_API_KEY`: Your project's secret key.
- `AXIS_BASE_URL`: (Optional) Defaults to `https://api.axis.sh/v1`.
