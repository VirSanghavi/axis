
from setuptools import setup, find_packages

setup(
    name="virsanghavi-axis",
    version="1.0.0",
    packages=find_packages(),
    install_requires=[
        "requests>=2.25.1",
    ],
    author="Axis Governance",
    author_email="vir@tilt.vote",
    description="Python SDK for the Axis Context Protocol",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    url="https://github.com/VirSanghavi/shared-context",
    keywords="axis context ai agents governance",
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
    python_requires='>=3.7',
)
