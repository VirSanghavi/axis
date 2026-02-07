
import requests
import json
import os

class Axis:
    """
    The main client for interacting with the Axis Context Protocol.
    """
    def __init__(self, api_key=None, base_url="https://api.axis.sh/v1"):
        self.api_key = api_key or os.environ.get("AXIS_API_KEY")
        self.base_url = base_url.rstrip("/")
        
        if not self.api_key:
            raise ValueError("AXIS_API_KEY is required. Pass it to the constructor or set it as an environment variable.")

    def get_mirror(self, path="."):
        """
        Retrieves the high-fidelity context mirror for a given path.
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        try:
            response = requests.get(
                f"{self.base_url}/context/mirror", 
                params={"path": path},
                headers=headers
            )
            response.raise_for_status()
            return AxisMirror(response.json())
        except Exception as e:
            raise Exception(f"Axis Mirror Error: {str(e)}")

    def check_governance(self, agent_id, file_path, action="read"):
        """
        Validates if an agent is permitted to perform an action on a file path.
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "agent_id": agent_id,
            "file_path": file_path,
            "action": action
        }
        try:
            response = requests.post(
                f"{self.base_url}/governance/check", 
                json=payload,
                headers=headers
            )
            response.raise_for_status()
            return response.json().get("allowed", False)
        except Exception as e:
            print(f"Axis Governance Error: {e}")
            return False

class AxisMirror:
    def __init__(self, data):
        self.raw = data
        self.nodes = [AxisNode(n) for n in data.get("nodes", [])]
        self.metadata = data.get("metadata", {})

    def to_prompt(self):
        """
        Converts the mirror into a condensed text block for LLM prompts.
        """
        output = "Axis Context Mirror:\n"
        for node in self.nodes:
            output += f"- {node.path} ({node.type})\n"
        return output

class AxisNode:
    def __init__(self, node_data):
        self.path = node_data.get("path") or node_data.get("name")
        self.type = node_data.get("type")
        self.size = node_data.get("size", 0)
        self.last_modified = node_data.get("last_modified")
