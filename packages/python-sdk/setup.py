
from setuptools import setup, find_packages

setup(
    name="virsanghavi-axis",
    version="1.0.2",
    packages=find_packages(),
    install_requires=[
        "requests>=2.25.1",
    ],
    author="Axis Governance",
    author_email="vir@tilt.vote",
    description="Python SDK for the Axis Context Protocol",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    # The repository was renamed to VirSanghavi/axis. The old path still 301s,
    # so this was not broken, but it breaks the day a new repo takes that name.
    url="https://github.com/VirSanghavi/axis",
    project_urls={
        "Homepage": "https://useaxis.dev",
        "Source": "https://github.com/VirSanghavi/axis",
        "Issues": "https://github.com/VirSanghavi/axis/issues",
    },
    keywords="axis mcp model-context-protocol coding-agent multi-agent agent-orchestration claude-code cursor",
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Build Tools",
        "Topic :: Software Development :: Libraries :: Python Modules",
    ],
    python_requires='>=3.7',
)
